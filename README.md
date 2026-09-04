# Suivi des ventes — « Les Doublages improvisés » au Théâtre du Splendid

Relevé quotidien automatique des places disponibles pour les **14 représentations**
(7 dates × 19h et 21h) de la Cie Alliance Créative, et dashboard statique publié
sur GitHub Pages.

- **Collecte** : GitHub Actions, 1×/jour, commit du snapshot dans le dépôt.
- **Dashboard** : page statique lisant directement le JSON versionné. Aucun backend.

---

## 1. Comment les données sont obtenues

La billetterie Tick&Live rend le plan de salle côté client, mais elle expose deux
ressources publiques exploitables — **sans authentification, sans panier, sans navigateur headless** :

| Ressource | Rôle |
|---|---|
| `GET /evenement/les-doublages-improvises` | La page embarque un bloc `<script>var events = [ … ];` listant **les 14 séances** avec leur date, leur heure, leur drapeau `soldOut` et l'URL contenant leur identifiant. |
| `GET /map/0/{sessionId}/zones` | JSON du plan de salle. La clé `areas` contient **un objet par siège encore achetable** (`seat: true`, `av: "1"`), avec sa zone (`ia` : `ORCHESTRE`, `1er BALCON`), sa rangée et son numéro. |

Le nombre de places libres est donc `Object.values(areas).filter(a => a.seat && a.av === "1").length`.

Identifiants des séances au moment de la mise en place (ils sont redécouverts à
chaque exécution, la liste ci-dessous n'est qu'indicative) :

| Date | 19h | 21h |
|---|---|---|
| lun. 12 oct. 2026 | `158873` | `158874` |
| lun. 9 nov. 2026 | `158871` | `158872` |
| lun. 21 déc. 2026 | `158867` | `158868` |
| lun. 4 janv. 2027 | `158869` | `158870` |
| lun. 22 févr. 2027 | `158861` | `158862` |
| lun. 29 mars 2027 | `158865` | `158866` |
| lun. 26 avr. 2027 | `158863` | `158864` |

> **Playwright n'est pas nécessaire.** L'API JSON répond en anonyme ; le scraper
> n'utilise que `fetch`. C'est la voie recommandée par le cahier des charges, et
> la plus rapide (~25 s pour les 14 séances, délai de politesse compris).

### ⚠️ La jauge totale n'est pas publiée

L'endpoint ne liste **que les sièges achetables**. Il ne dit jamais combien la
salle en compte au total. Conséquence : le nombre de places *vendues* ne peut pas
être lu directement, il doit être déduit d'une jauge de référence.

Deux modes, cumulables :

1. **`observed_max` (par défaut).** La jauge d'une séance est le plus grand nombre
   de places libres jamais relevé pour elle. C'est un **plancher** : les ventes
   antérieures au premier relevé ne sont pas comptées, donc le taux de remplissage
   est sous-estimé au démarrage, puis se stabilise.
2. **Jauge forcée (recommandé dès que le chiffre est connu).** Renseignez la jauge
   réelle mise en vente web dans `capacityOverrides` de `docs/data/history.json` :

   ```jsonc
   "capacityOverrides": {
     "158873": 350,
     "158874": 350
   }
   ```

   Toute séance listée là utilise cette valeur ; les autres restent en `observed_max`.
   Le dashboard affiche un bandeau tant qu'au moins une jauge est estimée.

### Autres limites connues

- Un siège **bloqué dans le panier d'un autre visiteur** disparaît de `areas`
  puis y revient à l'expiration du panier : de petites oscillations d'un relevé à
  l'autre sont normales et ne sont pas des ventes.
- Les places vendues **au guichet ou par un revendeur** ne sont visibles que si
  elles sont décomptées du contingent web.

---

## 2. Structure du dépôt

```
.github/workflows/
  collect.yml        # cron quotidien : relève + commit du snapshot
  pages.yml          # publie docs/ sur GitHub Pages à chaque push
src/
  collect.ts         # le collecteur (Node 22 + TypeScript, via tsx)
  types.ts           # schéma des données, commenté
docs/                # racine du site publié
  index.html         # dashboard (table + Chart.js), aucun build
  data/
    history.json     # ← la source de vérité : tous les snapshots
    latest.json      # vue dérivée du dernier relevé (confort / usage tiers)
```

### Schéma de `docs/data/history.json`

```jsonc
{
  "schemaVersion": 1,
  "event":   { "slug": "…", "title": "…", "venue": "…", "url": "…" },
  "capacityMode": "observed_max",
  "capacityOverrides": {},                  // { "158873": 350, … }
  "sessions": [                             // dernier état connu des 14 séances
    { "id": "158873", "date": "2026-10-12", "hour": "19:00",
      "soldOut": false, "url": "https://…/reserver/…/158873" }
  ],
  "snapshots": [                            // du plus ancien au plus récent
    {
      "ts":  "2026-09-04T18:56:40.602Z",    // horodatage UTC du relevé
      "day": "2026-09-04",                  // clé de déduplication (1 par jour)
      "readings": [
        { "id": "158873", "date": "2026-10-12", "hour": "19:00",
          "soldOut": false, "free": 31,
          "byZone": { "ORCHESTRE": 18, "1er BALCON": 13 } }
      ]
    }
  ]
}
```

Volume : 14 lignes/jour ≈ **1,5 Mo au bout d'un an**. Un JSON versionné suffit
largement, SQLite n'apporterait rien ici.

---

## 3. Déploiement

### 3.1 Pousser le dépôt

```bash
git remote add origin git@github.com:<votre-org>/alliance-splendid.git
git push -u origin main
```

### 3.2 Autoriser le workflow à committer

**Settings → Actions → General → Workflow permissions** → cocher
**« Read and write permissions »**, puis *Save*.

Sans ça, le `git push` du job `collect` échoue avec une erreur 403.
(Le workflow déclare déjà `permissions: contents: write`, mais le réglage du
dépôt plafonne ce que le token peut faire.)

### 3.3 Activer GitHub Pages

**Settings → Pages → Build and deployment → Source : GitHub Actions.**

Le workflow `pages.yml` publie le dossier `docs/` à chaque push qui le touche —
donc automatiquement après chaque relevé quotidien. L'URL apparaît dans
Settings → Pages (typiquement `https://<org>.github.io/alliance-splendid/`).

> Le site est public dès que Pages est activé sur un dépôt public. Pour le garder
> privé : dépôt privé + Pages en accès restreint (plans Team/Enterprise), ou
> consultez simplement `docs/index.html` en local.

### 3.4 Vérifier

Onglet **Actions → Collecte quotidienne des ventes → Run workflow**. Le run doit
afficher les 14 séances et leur nombre de places, puis committer.

---

## 4. Exploitation courante

```bash
npm ci
npm run collect        # relève et écrit docs/data/*.json
npm run collect:dry    # relève et affiche, sans rien écrire
npm run typecheck      # vérifie les types
```

Prévisualiser le dashboard en local (un simple `file://` ne suffit pas, `fetch` a
besoin d'un serveur) :

```bash
npx serve docs         # puis http://localhost:3000
```

### Le workflow est rouge, que faire ?

Le collecteur **échoue volontairement** plutôt que d'enregistrer un chiffre faux.
Les messages sont explicites :

| Message | Cause probable | Correctif |
|---|---|---|
| `Bloc \`var events = [...]\` introuvable` | Le gabarit de la page événement a changé. | Ouvrir la page, retrouver comment les séances sont listées, adapter `fetchSessions()`. |
| `N séance(s) trouvée(s), 14 attendue(s)` | Des dates ont été ajoutées ou retirées. | Si c'est voulu, ajuster `EXPECTED_SESSIONS` dans `src/collect.ts`. |
| `Réponse non-JSON` / `Clé \`areas\` absente` | L'endpoint plan de salle a changé, ou renvoie une page d'erreur. | Vérifier `https://billetterie-lesplendid.tickandlive.com/map/0/158873/zones` dans un navigateur. |
| `HTTP 4xx/5xx` après 3 tentatives | Indisponibilité passagère, ou blocage. | Relancer le workflow manuellement ; si ça persiste, espacer davantage les appels. |

### Bonnes pratiques respectées

- **Un seul passage par jour**, 1,5 s entre chaque séance, User-Agent identifiant.
- **Idempotent** : deux exécutions le même jour UTC remplacent le snapshot du jour
  au lieu d'en empiler deux. Relançable à volonté via `workflow_dispatch`.
- **Commit quotidien même sans changement** (`--allow-empty`) : cela maintient le
  dépôt actif et évite la désactivation automatique des workflows planifiés après
  60 jours d'inactivité.
- **Pas d'identifiants** : rien à stocker dans les GitHub Secrets, l'API est publique.

---

## 5. Le dashboard

- **Vue d'ensemble** — les 14 représentations : vendues / libres / jauge /
  % de remplissage, avec sous-total par soirée (19h + 21h) et total sur la série.
  Statut par séance : *Disponible*, *Quasi complet* (≥ 90 %), *Complet* (0 place),
  signalé par une icône **et** un libellé, jamais par la couleur seule.
- **Évolution dans le temps** — courbes des places encore disponibles :
  total de la série, par soirée (7 courbes), ou les deux séances d'une soirée choisie.
- Date et heure du dernier relevé affichées en tête (fuseau Europe/Paris).
- S'adapte au thème clair/sombre du système.

Pas d'alertes e-mail : non demandées.
