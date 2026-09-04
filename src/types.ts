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

/** Relevé de disponibilité d'une séance à un instant donné. */
export interface SessionReading {
  id: string;
  date: string;
  hour: string;
  soldOut: boolean;
  /** Nombre de sièges encore achetables (source: /map/0/{id}/zones). */
  free: number;
  /** Répartition des sièges libres par zone (ORCHESTRE, 1er BALCON, …). */
  byZone: Record<string, number>;
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
  schemaVersion: 2;
  event: EventMeta;
  /**
   * Jauge de référence, saisie à la main.
   *
   * La billetterie n'expose le total nulle part : l'endpoint `zones` ne renvoie
   * que les sièges achetables, le SVG du plan ne dessine que ceux-là, et les
   * sièges vendus n'existent que sous forme de pixels dans une image de fond
   * (la même pour les 14 séances). La jauge doit donc être fournie.
   */
  capacityMode: "fixed";
  /** Jauge appliquée à toute séance sans valeur propre. */
  defaultCapacity: number;
  /** Jauge spécifique à une séance, ex. { "158873": 280 }. Prime sur defaultCapacity. */
  capacityOverrides: Record<string, number>;
  /** Séances connues, dernier état vu (ordre chronologique). */
  sessions: SessionMeta[];
  /** Historique, du plus ancien au plus récent. */
  snapshots: Snapshot[];
}
