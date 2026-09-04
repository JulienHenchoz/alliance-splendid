/**
 * Reconstitution du plan et calcul des ventes réelles.
 *
 * ── Le problème ──────────────────────────────────────────────────────────
 * La billetterie ne liste que les sièges achetables. Un siège absent du flux
 * est soit VENDU, soit PAS ENCORE OUVERT à la vente : le théâtre n'ouvre pas
 * toute la salle d'emblée, il commence par les rangées proches de la scène et
 * ouvre de nouveaux paliers à mesure que la date approche (vraisemblablement
 * pour grouper le public plutôt que le disperser).
 *
 * Rapporter les places libres à la jauge physique de la salle donnait donc des
 * chiffres absurdes : une séance lointaine dont RIEN n'est vendu affichait
 * 71 % de remplissage, parce que les rangées non ouvertes étaient comptées
 * comme vendues.
 *
 * ── Ce qui rend le problème soluble ──────────────────────────────────────
 * 1. Une rangée ouverte n'est jamais refermée. Les paliers ne font que
 *    s'ajouter, dans le même ordre physique pour toutes les séances.
 * 2. Les séances les plus lointaines n'ont quasiment rien vendu : elles
 *    montrent leurs rangées ouvertes INTÉGRALEMENT libres, ce qui donne la
 *    taille réelle de ces rangées.
 * 3. Le `phid` de Tick&Live est un index dense sur le plan, ordonné par
 *    rangée : il donne l'ordre physique, donc l'ordre des paliers.
 *
 * ── La méthode ───────────────────────────────────────────────────────────
 * - Taille d'une rangée = le plus grand nombre de places vues libres
 *   simultanément dedans, toutes séances confondues (minorant auto-corrigé).
 * - Une rangée est « ouverte » pour une séance si au moins un de ses sièges y
 *   a été vu libre une fois.
 * - Par monotonie, si une rangée est ouverte, toutes celles qui la précèdent
 *   dans sa zone le sont aussi — même vendues à 100 %, donc invisibles. C'est
 *   ce qui rattrape les rangées H et I du 12 octobre.
 * - Jauge ouverte = somme des tailles des rangées ouvertes.
 * - Vendues = jauge ouverte − places libres.
 *
 * Orchestre et balcon sont traités comme deux séquences indépendantes : le
 * balcon s'ouvre dès le premier palier, alors que le fond d'orchestre attend.
 */

import type { History, PlanRow, SessionReading } from "./types.js";

/** Clé canonique d'une rangée. */
export function rowKey(zone: string, row: string): string {
  return `${zone}/${row}`;
}

function splitKey(key: string): { zone: string; row: string } {
  const i = key.lastIndexOf("/");
  return { zone: key.slice(0, i), row: key.slice(i + 1) };
}

/**
 * Reconstruit le catalogue des rangées.
 *
 * @param snapshots  tout l'historique, relevé du jour compris
 * @param observedOrder  rang physique (min phid) relevé lors de ce passage
 * @param previous  catalogue précédent, pour ne pas perdre un ordre déjà connu
 */
export function buildPlan(
  snapshots: History["snapshots"],
  observedOrder: Record<string, number>,
  observedPositions: Record<string, string[]>,
  previous: PlanRow[] = [],
): PlanRow[] {
  const order: Record<string, number> = {};
  const positions: Record<string, Set<string>> = {};
  for (const r of previous) {
    const key = rowKey(r.zone, r.row);
    order[key] = r.order;
    positions[key] = new Set(r.positions ?? []);
  }
  for (const [key, value] of Object.entries(observedOrder)) {
    const known = order[key];
    order[key] = known === undefined ? value : Math.min(known, value);
  }
  // Union cumulative : les numéros de place déjà connus ne se perdent jamais.
  for (const [key, list] of Object.entries(observedPositions)) {
    const set = (positions[key] ??= new Set<string>());
    for (const pos of list) set.add(pos);
  }

  // Une rangée est « établie » si une séance l'a montrée entièrement libre.
  const maxSimultaneous: Record<string, number> = {};
  for (const snap of snapshots) {
    for (const reading of snap.readings) {
      for (const [key, count] of Object.entries(reading.byRow ?? {})) {
        maxSimultaneous[key] = Math.max(maxSimultaneous[key] ?? 0, count);
      }
    }
  }

  return Object.keys(positions)
    .filter((key) => positions[key]!.size > 0)
    .map((key) => {
      const { zone, row } = splitKey(key);
      const list = [...positions[key]!].sort(comparePositions);
      return {
        zone,
        row,
        order: order[key] ?? Number.MAX_SAFE_INTEGER,
        positions: list,
        size: list.length,
        settled: (maxSimultaneous[key] ?? 0) >= list.length,
      };
    })
    .sort((a, b) => a.zone.localeCompare(b.zone) || a.order - b.order);
}

/** Tri des numéros de place : "9" avant "10", "12" avant "12B" (strapontin). */
function comparePositions(a: string, b: string): number {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  if (na !== nb) return (Number.isNaN(na) ? 0 : na) - (Number.isNaN(nb) ? 0 : nb);
  return a.localeCompare(b);
}

/**
 * Rangées ouvertes pour une séance, en distinguant ce qui est constaté de ce
 * qui est déduit.
 *
 * `seen` : au moins un siège y a été vu libre — certitude.
 * `inferred` : jamais vue, mais située avant une rangée ouverte dans sa zone.
 *   Une rangée ouverte n'étant jamais refermée, elle est forcément ouverte et
 *   vendue à 100 %. C'est ce qui rattrape H et I pour le 12 octobre.
 *
 * ⚠︎ La déduction suppose qu'une rangée s'ouvre entièrement. C'est le cas ici,
 * mais pas une règle du logiciel : « Le Procès d'une vie », dans la même salle
 * et sur le même plan, n'ouvre que 3 sièges de sa rangée D. Une rangée déduite
 * peut donc être surestimée — d'où `observedCapacity`, le plancher garanti.
 */
function openRowsFor(
  sessionId: string,
  snapshots: History["snapshots"],
  plan: PlanRow[],
): { seen: PlanRow[]; inferred: PlanRow[] } {
  const seenKeys = new Set<string>();
  for (const snap of snapshots) {
    for (const reading of snap.readings) {
      if (reading.id !== sessionId) continue;
      for (const [key, count] of Object.entries(reading.byRow ?? {})) {
        if (count > 0) seenKeys.add(key);
      }
    }
  }
  if (!seenKeys.size) return { seen: [], inferred: [] };

  const depth: Record<string, number> = {};
  for (const r of plan) {
    if (!seenKeys.has(rowKey(r.zone, r.row))) continue;
    depth[r.zone] = Math.max(depth[r.zone] ?? -Infinity, r.order);
  }

  const seen: PlanRow[] = [];
  const inferred: PlanRow[] = [];
  for (const r of plan) {
    if (r.order > (depth[r.zone] ?? -Infinity)) continue;
    (seenKeys.has(rowKey(r.zone, r.row)) ? seen : inferred).push(r);
  }
  return { seen, inferred };
}

/**
 * Recalcule les champs dérivés de TOUS les relevés.
 *
 * Le recalcul est intégral à chaque passage : quand le catalogue s'affine
 * (nouveau palier observé sur une séance peu vendue), tout l'historique en
 * bénéficie rétroactivement, sans recollecte.
 */
export function annotate(history: History): void {
  const plan = history.plan.rows;
  const openBySession = new Map<string, ReturnType<typeof openRowsFor>>();

  for (const session of history.sessions) {
    openBySession.set(session.id, openRowsFor(session.id, history.snapshots, plan));
  }

  // Une séance dont le palier est MOINS profond que celui d'une séance plus
  // lointaine est suspecte : les paliers ne reculent pas dans le temps, donc
  // un palier lui est probablement ouvert mais vendu à 100 %, donc invisible.
  const depthOf = (id: string, zone: string): number => {
    const all = openBySession.get(id);
    const rows = [...(all?.seen ?? []), ...(all?.inferred ?? [])].filter((r) => r.zone === zone);
    return rows.length ? Math.max(...rows.map((r) => r.order)) : -Infinity;
  };
  const zones = [...new Set(plan.map((r) => r.zone))];
  const keyOf = new Map(history.sessions.map((s) => [s.id, `${s.date} ${s.hour}`]));
  const shallowForItsDate = new Set<string>();
  for (const a of history.sessions) {
    for (const b of history.sessions) {
      if (a.id === b.id) continue;
      if ((keyOf.get(b.id) ?? "") <= (keyOf.get(a.id) ?? "")) continue;
      if (zones.some((z) => depthOf(b.id, z) > depthOf(a.id, z))) {
        shallowForItsDate.add(a.id);
        break;
      }
    }
  }

  for (const snap of history.snapshots) {
    for (const reading of snap.readings) {
      const groups = openBySession.get(reading.id) ?? { seen: [], inferred: [] };
      const all = [...groups.seen, ...groups.inferred];
      const forced = history.capacityOverrides[reading.id];
      const computed = all.reduce((sum, r) => sum + r.size, 0);
      const capacity = typeof forced === "number" && forced > 0 ? forced : computed;

      reading.openCapacity = capacity;
      reading.observedCapacity = groups.seen.reduce((sum, r) => sum + r.size, 0);
      reading.sold = Math.max(0, capacity - reading.free);
      reading.fillRate = capacity > 0 ? Math.round((reading.sold / capacity) * 1000) / 10 : 0;

      if (forced) {
        reading.capacityIsEstimate = false;
        delete reading.capacityNote;
        continue;
      }

      const reasons: string[] = [];
      if (groups.inferred.length) {
        reasons.push(
          `rangée${groups.inferred.length > 1 ? "s" : ""} ` +
            groups.inferred.map((r) => r.row).join(", ") +
            ` comptée${groups.inferred.length > 1 ? "s" : ""} ouverte${
              groups.inferred.length > 1 ? "s" : ""
            } mais jamais vue${groups.inferred.length > 1 ? "s" : ""} : ` +
            `vendue${groups.inferred.length > 1 ? "s" : ""} à 100 %`,
        );
      }
      const unsettled = all.filter((r) => !r.settled);
      if (unsettled.length) {
        reasons.push(
          `taille de ${unsettled.map((r) => r.row).join(", ")} encore incertaine ` +
            `(jamais vue${unsettled.length > 1 ? "s" : ""} entièrement libre${
              unsettled.length > 1 ? "s" : ""
            })`,
        );
      }
      if (shallowForItsDate.has(reading.id)) {
        reasons.push("palier moins profond que celui d'une séance plus lointaine");
      }

      reading.capacityIsEstimate = reasons.length > 0;
      if (reasons.length) {
        reading.capacityNote =
          `Estimation. ${reasons.join(" ; ")}. Plancher garanti : ` +
          `${reading.observedCapacity} places.`;
      } else {
        delete reading.capacityNote;
      }
    }
  }
}

/** Détail lisible d'une séance, pour les logs. */
export function explain(history: History, reading: SessionReading): string {
  const groups = openRowsFor(reading.id, history.snapshots, history.plan.rows);
  const byZone: Record<string, string[]> = {};
  for (const r of groups.seen) (byZone[r.zone] ??= []).push(`${r.row}${r.size}`);
  // Les rangées déduites sont notées entre parenthèses.
  for (const r of groups.inferred) (byZone[r.zone] ??= []).push(`(${r.row}${r.size})`);
  return Object.entries(byZone)
    .map(([zone, list]) => `${zone} ${list.join(" ")}`)
    .join(" | ");
}
