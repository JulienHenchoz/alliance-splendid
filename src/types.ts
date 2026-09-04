/** Schéma des données persistées dans docs/data/history.json */

export interface EventMeta {
  /** Slug de l'événement sur la billetterie Tick&Live. */
  slug: string;
  title: string;
  venue: string;
  /** URL publique de la page événement (source des séances). */
  url: string;
}

/** Une séance telle que déclarée par la page événement. */
export interface SessionMeta {
  /** Identifiant Tick&Live de la séance (ex. "158873"). */
  id: string;
  /** Date locale de la représentation, format YYYY-MM-DD. */
  date: string;
  /** Heure locale, format HH:mm. */
  hour: string;
  /** Drapeau « complet » fourni par la billetterie. */
  soldOut: boolean;
  /** URL de la page de réservation. */
  url: string;
}

/**
 * Une rangée du plan, telle que reconstituée à partir des relevés.
 *
 * Le théâtre n'ouvre pas toute la salle d'emblée : il commence par les rangées
 * proches de la scène et ouvre de nouveaux paliers à mesure que la date
 * approche. Un siège absent du flux est donc soit vendu, soit pas encore
 * ouvert — et ce catalogue sert à distinguer les deux.
 */
export interface PlanRow {
  /** "ORCHESTRE", "1er BALCON", … */
  zone: string;
  /** Lettre de rangée ("B", "C", …). */
  row: string;
  /** Rang physique dans la zone, dérivé du `phid` Tick&Live (index dense du plan). */
  order: number;
  /**
   * Numéros de place distincts vus libres au moins une fois dans cette rangée,
   * toutes séances et tous relevés confondus (ex. ["1","2",…,"12B"]).
   *
   * L'union est cumulative : chaque séance libère des sièges différents, donc
   * l'union en révèle davantage que n'importe quel relevé isolé. La rangée J
   * n'a jamais montré plus de 4 places libres d'un coup, mais 8 sièges
   * distincts sur l'ensemble des séances.
   */
  positions: string[];
  /** Taille constatée = `positions.length`. Minorant, qui s'affine avec le temps. */
  size: number;
  /**
   * true si une séance a montré cette rangée entièrement libre (autant de
   * places libres que de positions connues). Sinon sa taille reste un
   * plancher, et les séances qui l'utilisent portent une jauge minorée.
   */
  settled: boolean;
}

/** Relevé de disponibilité d'une séance à un instant donné. */
export interface SessionReading {
  id: string;
  date: string;
  hour: string;
  soldOut: boolean;
  /** Nombre de sièges encore achetables (source: /map/0/{id}/zones). */
  free: number;
  /** Places libres par rangée, clé `ZONE/RANGÉE` (ex. "ORCHESTRE/B"). */
  byRow: Record<string, number>;

  /* --- Champs dérivés : recalculés intégralement à chaque passage, ---
     --- pour que l'historique bénéficie des progrès du catalogue.    --- */

  /** Places ouvertes à la vente pour cette séance (somme des rangées ouvertes). */
  openCapacity?: number;
  /** openCapacity − free. */
  sold?: number;
  /** Pourcentage de remplissage des places ouvertes. */
  fillRate?: number;
  /** true si au moins une rangée comptée n'a pas de taille corroborée. */
  capacityIsLowerBound?: boolean;
}

/** Un passage complet du collecteur. */
export interface Snapshot {
  /** Horodatage UTC ISO-8601 du relevé. */
  ts: string;
  /** Jour UTC (YYYY-MM-DD) — clé de déduplication : un snapshot par jour. */
  day: string;
  readings: SessionReading[];
}

export interface History {
  /** Version du schéma, pour migrations futures. */
  schemaVersion: 3;
  event: EventMeta;
  /**
   * Jauge physique de la salle. Purement indicative : elle sert de seconde
   * référence à l'affichage, jamais au calcul du taux de remplissage — la
   * majorité des rangées n'est pas mise en vente pour ce spectacle.
   */
  venueCapacity: number;
  /**
   * Jauge « ouverte » forcée pour une séance, si le théâtre communique le
   * chiffre exact. Prime sur le calcul par paliers. Ex. { "158873": 140 }.
   */
  capacityOverrides: Record<string, number>;
  /** Catalogue du plan, reconstruit à chaque passage. */
  plan: { rows: PlanRow[] };
  /** Séances connues, dernier état vu (ordre chronologique). */
  sessions: SessionMeta[];
  /** Historique, du plus ancien au plus récent. */
  snapshots: Snapshot[];
}
