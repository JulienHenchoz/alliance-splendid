/**
 * Collecteur de disponibilité — « Les Doublages improvisés » au Théâtre du Splendid.
 *
 * Deux appels seulement par exécution complète :
 *   1. la page événement, qui embarque la liste des séances (`var events = [...]`) ;
 *   2. pour chaque séance, GET /map/0/{sessionId}/zones qui renvoie en JSON les
 *      sièges ENCORE ACHETABLES (un objet `areas` par siège libre).
 *
 * L'endpoint est public : aucune authentification, aucun panier, aucun navigateur.
 *
 * Le script est idempotent : deux exécutions le même jour UTC remplacent le
 * snapshot du jour au lieu d'en empiler un second.
 *
 * Il échoue explicitement (exit 1) si la structure attendue n'est plus là —
 * mieux vaut un workflow rouge qu'un historique silencieusement faux.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { History, SessionMeta, SessionReading, Snapshot } from "./types.js";
import { annotate, buildPlan, explain, rowKey } from "./model.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_PATH = resolve(ROOT, "docs/data/history.json");
const LATEST_PATH = resolve(ROOT, "docs/data/latest.json");

const ORIGIN = "https://billetterie-lesplendid.tickandlive.com";
const SLUG = "les-doublages-improvises";
const EVENT_URL = `${ORIGIN}/evenement/${SLUG}`;

/** Nombre de séances attendues (7 dates × 19h/21h). Garde-fou. */
const EXPECTED_SESSIONS = 14;

/**
 * Jauge physique de la salle, à titre indicatif seulement.
 *
 * Elle ne sert JAMAIS au calcul du taux de remplissage : le théâtre n'ouvre
 * qu'une fraction des rangées à la vente (87 places au premier palier, sur
 * ~300 dans la salle), et les rangées A, F, G, L, M, O, P ainsi que le 2e
 * balcon ne sont ouvertes pour aucune séance de cette série. Voir model.ts.
 */
const VENUE_CAPACITY = 300;
/** Politesse : délai entre deux appels séance. */
const DELAY_MS = 1_500;
const TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

const USER_AGENT =
  "alliance-splendid-tracker/1.0 (suivi interne des ventes Cie Alliance Créative; +https://github.com)";

const DRY_RUN = process.argv.includes("--dry-run");

/* ------------------------------------------------------------------ utils */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

class CollectError extends Error {}

/** GET avec timeout et retry exponentiel léger. */
async function fetchText(url: string, accept: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: accept },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if (!res.ok) throw new CollectError(`HTTP ${res.status} sur ${url}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        const backoff = 2_000 * attempt;
        log(`  ⚠︎ tentative ${attempt}/${MAX_ATTEMPTS} échouée (${String(err)}) — nouvel essai dans ${backoff} ms`);
        await sleep(backoff);
      }
    }
  }
  throw new CollectError(`Échec après ${MAX_ATTEMPTS} tentatives sur ${url} : ${String(lastError)}`);
}

/* -------------------------------------------------------- 1. les séances */

/** Forme brute d'une entrée du tableau `events` embarqué dans la page. */
interface RawEvent {
  date: string;
  dateLabel: string;
  hour: string;
  soldOut: boolean;
  url: string;
}

/**
 * Extrait la liste des séances depuis la page événement.
 * La page contient un bloc `<script>var daylist = [...]; var events = [ {...}, {...} ];`
 */
async function fetchSessions(): Promise<SessionMeta[]> {
  const html = await fetchText(EVENT_URL, "text/html");
  const match = html.match(/var\s+events\s*=\s*\[([\s\S]*?)\];/);
  if (!match?.[1]) {
    throw new CollectError(
      "Bloc `var events = [...]` introuvable sur la page événement — le gabarit Tick&Live a probablement changé.",
    );
  }

  let raw: RawEvent[];
  try {
    raw = JSON.parse(`[${match[1].replace(/,\s*$/, "")}]`) as RawEvent[];
  } catch (err) {
    throw new CollectError(`Le tableau \`events\` n'est pas du JSON valide : ${String(err)}`);
  }

  const sessions: SessionMeta[] = raw.map((e) => {
    const id = e.url.split("/").pop() ?? "";
    if (!/^\d+$/.test(id)) {
      throw new CollectError(`Identifiant de séance illisible dans l'URL « ${e.url} »`);
    }
    return { id, date: e.date, hour: e.hour, soldOut: Boolean(e.soldOut), url: e.url };
  });

  if (sessions.length !== EXPECTED_SESSIONS) {
    throw new CollectError(
      `${sessions.length} séance(s) trouvée(s), ${EXPECTED_SESSIONS} attendue(s). ` +
        `Si la programmation a réellement changé, ajustez EXPECTED_SESSIONS dans src/collect.ts.`,
    );
  }

  sessions.sort((a, b) => `${a.date} ${a.hour}`.localeCompare(`${b.date} ${b.hour}`));
  return sessions;
}

/* --------------------------------------------- 2. la dispo d'une séance */

/** Un siège tel que renvoyé par /map/0/{id}/zones. */
interface Area {
  /** true pour un siège numéroté, false pour une zone/forme décorative. */
  seat?: boolean;
  /** "1" = achetable. L'endpoint ne renvoie que des sièges disponibles. */
  av?: string;
  /** Zone d'implantation : "ORCHESTRE", "1er BALCON", … */
  ia?: string;
  /** Désignation : `r` = rangée, `p` = numéro de place. */
  da?: { r?: string | null; p?: string | null };
  /** `phid` = index dense du siège dans le plan, ordonné par rangée. */
  cust?: { phid?: string };
}

interface ZonesResponse {
  areas?: Record<string, Area>;
}

/**
 * Relève les places libres d'une séance.
 *
 * Attention : l'endpoint ne liste QUE les sièges achetables. Un siège
 * momentanément bloqué dans le panier d'un autre visiteur en disparaît, puis
 * réapparaît à l'expiration du panier — d'où de petites oscillations normales.
 */
async function fetchAvailability(
  session: SessionMeta,
): Promise<{
  reading: SessionReading;
  order: Record<string, number>;
  positions: Record<string, string[]>;
}> {
  const url = `${ORIGIN}/map/0/${session.id}/zones`;
  const body = await fetchText(url, "application/json");

  let json: ZonesResponse;
  try {
    json = JSON.parse(body) as ZonesResponse;
  } catch {
    throw new CollectError(
      `Réponse non-JSON pour la séance ${session.id} (${session.date} ${session.hour}) — ` +
        `l'API a peut-être changé ou renvoyé une page d'erreur. Extrait : ${body.slice(0, 160)}`,
    );
  }

  // `areas` absent = structure inattendue → on échoue.
  // `areas` vide = séance complète → 0 place, c'est une valeur légitime.
  if (!json.areas || typeof json.areas !== "object") {
    throw new CollectError(
      `Clé \`areas\` absente de la réponse pour la séance ${session.id} (${session.date} ${session.hour}).`,
    );
  }

  const seats = Object.values(json.areas).filter((a) => a.seat === true && a.av === "1");

  // Détail par rangée : c'est lui qui permet de distinguer « vendu » de
  // « pas encore ouvert à la vente » (voir model.ts).
  const byRow: Record<string, number> = {};
  const order: Record<string, number> = {};
  const positions: Record<string, string[]> = {};
  for (const seat of seats) {
    const key = rowKey(seat.ia ?? "AUTRE", seat.da?.r ?? "?");
    byRow[key] = (byRow[key] ?? 0) + 1;
    const pos = seat.da?.p;
    if (pos) (positions[key] ??= []).push(String(pos));
    const phid = Number(seat.cust?.phid);
    if (Number.isFinite(phid)) {
      const known = order[key];
      order[key] = known === undefined ? phid : Math.min(known, phid);
    }
  }

  return {
    reading: {
      id: session.id,
      date: session.date,
      hour: session.hour,
      soldOut: session.soldOut,
      free: seats.length,
      byRow,
    },
    order,
    positions,
  };
}

/* ------------------------------------------------------- 3. persistance */

function emptyHistory(): History {
  return {
    schemaVersion: 3,
    event: {
      slug: SLUG,
      title: "Les Doublages improvisés",
      venue: "Théâtre du Splendid — 48 rue du Faubourg Saint-Martin, 75010 Paris",
      url: EVENT_URL,
    },
    venueCapacity: VENUE_CAPACITY,
    capacityOverrides: {},
    plan: { rows: [] },
    sessions: [],
    snapshots: [],
  };
}

async function loadHistory(): Promise<History> {
  try {
    const parsed = JSON.parse(await readFile(HISTORY_PATH, "utf8")) as Partial<History> & {
      schemaVersion: number;
    };

    if (parsed.schemaVersion !== 3) {
      // Les schémas 1 et 2 ne stockaient qu'un total par séance, sans détail
      // par rangée : ils ne permettent pas de distinguer « vendu » de « pas
      // encore ouvert ». Impossible de les convertir, on repart proprement.
      log(
        `Historique en schéma v${String(parsed.schemaVersion)} — sans détail par rangée, ` +
          `donc inexploitable par le modèle actuel. Repart d'un historique neuf.`,
      );
      return emptyHistory();
    }

    parsed.venueCapacity ??= VENUE_CAPACITY;
    parsed.capacityOverrides ??= {};
    parsed.plan ??= { rows: [] };
    parsed.snapshots ??= [];
    parsed.sessions ??= [];
    return parsed as History;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log("Aucun historique existant — création d'un fichier neuf.");
      return emptyHistory();
    }
    throw err;
  }
}

/** Vue dérivée du dernier relevé : pratique pour un coup d'œil ou un usage tiers. */
function buildLatest(history: History) {
  const last = history.snapshots.at(-1);
  if (!last) return null;
  const rows = last.readings;
  return {
    ts: last.ts,
    event: history.event,
    venueCapacity: history.venueCapacity,
    plan: history.plan,
    sessions: rows,
    total: {
      openCapacity: rows.reduce((s, r) => s + (r.openCapacity ?? 0), 0),
      free: rows.reduce((s, r) => s + r.free, 0),
      sold: rows.reduce((s, r) => s + (r.sold ?? 0), 0),
    },
  };
}

/* -------------------------------------------------------------- 4. main */

async function main(): Promise<void> {
  log(`Collecte — ${EVENT_URL}`);

  const sessions = await fetchSessions();
  log(`${sessions.length} séances identifiées : ${sessions.map((s) => `${s.date} ${s.hour}`).join(", ")}`);

  const readings: SessionReading[] = [];
  const observedOrder: Record<string, number> = {};
  const observedPositions: Record<string, string[]> = {};
  for (const [i, session] of sessions.entries()) {
    const { reading, order, positions } = await fetchAvailability(session);
    log(`  ${session.date} ${session.hour} (#${session.id}) → ${reading.free} place(s) libre(s)`);
    readings.push(reading);
    for (const [key, phid] of Object.entries(order)) {
      const known = observedOrder[key];
      observedOrder[key] = known === undefined ? phid : Math.min(known, phid);
    }
    for (const [key, list] of Object.entries(positions)) {
      (observedPositions[key] ??= []).push(...list);
    }
    if (i < sessions.length - 1) await sleep(DELAY_MS);
  }

  const now = new Date();
  const snapshot: Snapshot = {
    ts: now.toISOString(),
    day: now.toISOString().slice(0, 10),
    readings,
  };

  const history = await loadHistory();
  history.sessions = sessions;

  const sameDayIndex = history.snapshots.findIndex((s) => s.day === snapshot.day);
  if (sameDayIndex >= 0) {
    log(`Snapshot existant pour ${snapshot.day} — remplacé (script idempotent).`);
    history.snapshots[sameDayIndex] = snapshot;
  } else {
    history.snapshots.push(snapshot);
  }
  history.snapshots.sort((a, b) => a.ts.localeCompare(b.ts));

  // Le catalogue du plan puis TOUS les champs dérivés sont recalculés à chaque
  // passage : quand un nouveau palier s'ouvre sur une séance peu vendue, on
  // apprend la taille réelle de ses rangées et tout l'historique se corrige.
  history.plan.rows = buildPlan(
    history.snapshots,
    observedOrder,
    observedPositions,
    history.plan.rows,
  );
  annotate(history);

  log("");
  log("Places ouvertes à la vente (rangées ouvertes, taille constatée) :");
  for (const r of readings) {
    const mark = r.capacityIsEstimate ? "~" : " ";
    log(
      `  ${r.date} ${r.hour} : ${String(r.sold).padStart(3)} vendues / ` +
        `${String(r.free).padStart(3)} libres sur ${mark}${String(r.openCapacity).padStart(3)} ` +
        `ouvertes (${r.fillRate}%)  ${explain(history, r)}`,
    );
  }

  const unsettled = history.plan.rows.filter((r) => !r.settled);
  if (unsettled.length) {
    log("");
    log(
      "Rangées jamais vues entièrement libres — leur taille reste un plancher, " +
        "d'où une part des estimations : " +
        unsettled.map((r) => `${r.zone}/${r.row}=${r.size}`).join(", "),
    );
  }

  const totalFree = readings.reduce((s, r) => s + r.free, 0);
  const totalOpen = readings.reduce((s, r) => s + (r.openCapacity ?? 0), 0);
  log("");
  log(
    `Total : ${totalOpen - totalFree} vendues / ${totalFree} libres sur ${totalOpen} ` +
      `places ouvertes — ${history.snapshots.length} snapshot(s) en historique.`,
  );

  if (DRY_RUN) {
    log("--dry-run : rien n'est écrit sur le disque.");
    return;
  }

  await mkdir(dirname(HISTORY_PATH), { recursive: true });
  await writeFile(HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  await writeFile(LATEST_PATH, `${JSON.stringify(buildLatest(history), null, 2)}\n`, "utf8");
  log(`Écrit : ${HISTORY_PATH}`);
  log(`Écrit : ${LATEST_PATH}`);
}

main().catch((err: unknown) => {
  console.error("\n❌ Échec de la collecte :", err instanceof Error ? err.message : err);
  console.error(
    "\nLe DOM ou l'API de Tick&Live a peut-être évolué. Vérifier manuellement :\n" +
      `  - ${EVENT_URL} (bloc « var events = [...] »)\n` +
      `  - ${ORIGIN}/map/0/<sessionId>/zones (clé « areas »)`,
  );
  process.exitCode = 1;
});
