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

### ⚠️ Le point délicat : ouvert à la vente ≠ vendu

Un siège absent du flux est soit **vendu**, soit **pas encore ouvert à la vente**.
Le théâtre n'ouvre pas toute la salle d'emblée : il commence par les rangées
proches de la scène et ajoute des paliers à mesure que la date approche —
vraisemblablement pour grouper le public plutôt que le disperser.

Rapporter les places libres à la jauge physique donnait donc des chiffres faux :
le 26 avril 2027, dont **rien n'est vendu**, s'affichait à 71 % de remplissage,
parce que les rangées non ouvertes étaient comptées comme vendues.

**Les paliers observés**, reconstitués en croisant les 14 séances :

| Palier | Orchestre | 1er balcon | Cumul |
|---|---|---|---|
| 1 | B(13) C(14) D(13) E(14) | R(3) S(3) T(13) U(14) | **87** |
| 2 | + H(13) I(14) | | **114** |
| 3 | + J K N | | **131+** |

Les rangées A, F, G, L, M, O, P et tout le 2ᵉ balcon n'apparaissent dans aucune
séance : elles ne sont ouvertes pour aucune date de cette série.

**Ce qui rend le problème soluble** (voir `src/model.ts`) :

1. Une rangée ouverte n'est jamais refermée — les paliers ne font que s'ajouter,
   dans le même ordre physique pour toutes les séances.
2. Les séances lointaines n'ont presque rien vendu : elles montrent leurs
   rangées ouvertes **intégralement libres**, ce qui en donne la taille réelle.
3. Le `phid` de Tick&Live est un index dense sur le plan, ordonné par rangée :
   il donne l'ordre physique, donc l'ordre des paliers.

**La méthode :**

- Taille d'une rangée = nombre de numéros de place distincts vus libres au moins
  une fois, toutes séances confondues. (Compter les places d'un seul relevé ne
  suffit pas : la rangée J n'a jamais montré plus de 4 places libres d'un coup,
  mais 8 sièges distincts sur l'ensemble des séances.)
- Une rangée est **ouverte** pour une séance si un de ses sièges y a été vu libre.
- Par **monotonie**, si une rangée est ouverte, celles qui la précèdent dans sa
  zone le sont aussi — même vendues à 100 %, donc invisibles. C'est ce qui
  rattrape H et I pour le 12 octobre.
- Jauge ouverte = somme des tailles des rangées ouvertes ; vendues = jauge − libres.

Orchestre et balcon sont deux séquences indépendantes : le balcon s'ouvre dès le
premier palier alors que le fond d'orchestre attend.

**Ce que dit (et ne dit pas) Tick&Live.** L'éditeur ne publie aucune
documentation technique ni API publique — le site vitrine ne décrit que les
modules commerciaux. L'API a été sondée directement : aucun paramètre
(`view`, `zone`, `new`) ne change la réponse, aucun endpoint frère
(`/quota`, `/availability`, `/stats`) n'existe, et aucun siège n'est jamais
renvoyé avec `av:"0"`. Une seule catégorie (« CATEGORIE UNIQUE ») et un seul
tarif (« WEB », 33 €) : rien dans la structure des données n'encode l'ouverture.

**Il n'y a donc pas de règle à découvrir : l'ouverture est un paramétrage
manuel de back-office**, propre à chaque spectacle. La comparaison avec
« Le Procès d'une vie », qui joue dans la même salle sur le **même plan
physique** (les `phid` coïncident exactement : balcon R = 290-294,
T = 298-310, orchestre I = 141-154 dans les deux spectacles), le démontre :

| | Les Doublages improvisés | Le Procès d'une vie |
|---|---|---|
| Catégories | 1 (unique, 33 €) | 3 (39 €, 31 €, Carré OR 44 €) |
| Rangées ouvertes | B C D E H I J K N + R S T U | A B C D E F G I J L + R S T U V W |
| Granularité | rangées entières (B = 1→13) | **partielle** : D = places 12, 14, 14B |
| Étiquetage | B = phid 19-31 | B = phid **24-33** |

Trois conséquences pour ce projet :

1. **Aucune inférence d'un spectacle à l'autre.** Les lettres de rangée sont
   réattribuées par spectacle — la rangée « B » des Doublages et celle du
   Procès ne désignent pas les mêmes sièges. Seul le `phid` est stable.
2. **Une rangée peut n'être ouverte que partiellement.** Ce n'est pas le cas
   ici (les rangées ouvertes le sont entièrement, positions 1→13 ou 1→14),
   mais le Procès prouve que le logiciel le permet. Une rangée *déduite*
   ouverte peut donc être surestimée.
3. **L'estimation va dans les deux sens**, d'où le champ `observedCapacity` :
   le total des rangées réellement constatées ouvertes, seul plancher garanti.

**Les jauges estimées, marquées « ~ ».** Trois causes, cumulables :
une rangée déduite ouverte sans avoir jamais été vue (elle pourrait n'être
ouverte qu'en partie → surestimation), une rangée jamais vue entièrement libre
(taille sous-estimée), ou un palier moins profond que celui d'une séance plus
lointaine. Le dashboard affiche la raison exacte au survol, avec le plancher
garanti. Ces estimations **s'affinent d'elles-mêmes** : quand le théâtre
ouvrira un nouveau palier sur une date encore peu vendue, ses rangées
apparaîtront quasi vides et leur taille sera enfin connue. Le recalcul étant
intégral à chaque passage, tout l'historique se corrige rétroactivement, sans
recollecte. Au relevé du 4 septembre 2026 : **11 séances exactes, 3 estimées**.

Si le théâtre vous communique les chiffres exacts, `capacityOverrides` dans
`docs/data/history.json` prend le pas sur tout le calcul :

```jsonc
"venueCapacity": 300,          // jauge physique, indicative uniquement
"capacityOverrides": { "158873": 140 }
```

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
setup-github.sh      # crée le dépôt, pousse, configure Actions + Pages
src/
  collect.ts         # le collecteur (Node 22 + TypeScript, via tsx)
  model.ts           # reconstitution du plan, paliers, calcul des ventes
  types.ts           # schéma des données, commenté
docs/                # racine du site publié
  index.html         # dashboard (tableau + Chart.js), aucun build
  vendor/
    chart.umd.js     # Chart.js 4.4.6 (MIT), embarqué — aucun CDN
  data/
    history.json     # ← la source de vérité : tous les snapshots
    latest.json      # vue dérivée du dernier relevé (confort / usage tiers)
```

### Schéma de `docs/data/history.json`

```jsonc
{
  "schemaVersion": 3,
  "event":   { "slug": "…", "title": "…", "venue": "…", "url": "…" },
  "venueCapacity": 300,                     // jauge physique, indicative
  "capacityOverrides": {},                  // jauge ouverte forcée : { "158873": 140 }
  "plan": { "rows": [                       // catalogue reconstruit à chaque passage
    { "zone": "ORCHESTRE", "row": "B", "order": 19,
      "positions": ["1","2","…","13"], "size": 13, "settled": true }
  ]},
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
          "soldOut": false, "free": 29,
          "byRow": { "ORCHESTRE/B": 2, "ORCHESTRE/C": 1, "1er BALCON/U": 8 },
          // champs dérivés, recalculés à chaque passage
          "openCapacity": 131, "sold": 102, "fillRate": 77.9,
          "capacityIsLowerBound": true }
      ]
    }
  ]
}
```

Volume : 14 lignes/jour ≈ **1,5 Mo au bout d'un an**. Un JSON versionné suffit
largement, SQLite n'apporterait rien ici.

---

## 3. Déploiement

### Voie rapide — un seul script

```bash
brew install gh && gh auth login     # une fois, si ce n'est pas déjà fait
./setup-github.sh                    # ou : ./setup-github.sh <nom-du-depot>
```

Le script crée le dépôt **public** `alliance-splendid` sous votre compte, pousse
la branche `main`, applique les deux réglages faciles à oublier (workflows en
écriture, Pages en source *GitHub Actions*), puis déclenche un premier relevé.
Il est **rejouable** : si le dépôt existe déjà, il le réutilise au lieu d'échouer.
Pour un dépôt privé, remplacez `--public` par `--private` en tête du script —
attention, Pages sur dépôt privé exige un plan Team/Enterprise.

Les sections suivantes détaillent ce que le script fait, si vous préférez à la main.

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

### 3.4 Comment l'automatisation se déclenche

| Workflow | Déclencheur | Effet |
|---|---|---|
| Collecte quotidienne des ventes | `cron: 37 6` et `23 12` (UTC) + relance manuelle | Relève les 14 séances et committe le snapshot |
| Publier le dashboard | fin de la collecte, ou tout push touchant `docs/` | Reconstruit et publie le site |

Trois points qui font échouer silencieusement ce genre de montage, et qui sont
traités ici :

1. **Un workflow planifié ne démarre que si son fichier est sur la branche par
   défaut**, et sa première exécution a lieu au prochain créneau — jamais au
   moment du push. Pour l'enregistrer et le vérifier tout de suite :
   `gh workflow run collect.yml` (ou Actions → Run workflow).
2. **Un commit poussé par un workflow avec le `GITHUB_TOKEN` par défaut ne
   déclenche aucun autre workflow.** Le commit quotidien ne produit donc pas
   d'événement `push` : la publication est câblée sur `workflow_run` (fin de la
   collecte). Sans ça, les données seraient à jour dans le dépôt mais le site
   publié resterait figé sur le premier relevé.
3. **L'ordonnanceur de GitHub n'offre aucune garantie.** Les tâches planifiées
   sont mises en file, retardées de plusieurs dizaines de minutes en période de
   charge, et parfois purement abandonnées ; celles de la minute 0 subissent le
   pic et sont les plus touchées. D'où deux précautions : des minutes
   « quelconques » (`37 6` et non `0 6`), et **deux créneaux par jour**
   (`37 6` puis `23 12` UTC). Le script étant idempotent — un snapshot par jour
   UTC, remplacé et non empilé — le second passage ne coûte rien et rattrape un
   créneau sauté. Un premier créneau planifié peut aussi mettre plusieurs
   heures à être pris en compte après la création du dépôt : d'ici là,
   `gh workflow run collect.yml` fait le travail.

Rappel : GitHub **désactive** les workflows planifiés après 60 jours sans
activité sur le dépôt. Le commit quotidien — y compris à vide — l'évite.

### 3.5 Vérifier

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

- **Aucune dépendance externe** — Chart.js est versionné dans `docs/vendor/`.
  Le site ne charge rien depuis un CDN : rien à casser le jour où une URL change
  (c'est précisément ce qui est arrivé avec `cdnjs/Chart.js/4.4.6`, absent de
  cdnjs, d'où un graphique manquant en production). Pour changer de version :
  `npm i chart.js@<version>` puis copier `node_modules/chart.js/dist/chart.umd.js`
  dans `docs/vendor/`.
- **Lien billetterie** — chaque ligne de séance porte une icône de billet qui
  ouvre sa page de réservation Tick&Live dans un nouvel onglet.
- **Mobile** — sous 640 px, le tableau devient une liste de cartes : une par
  séance, groupées par soirée. Plus de défilement horizontal. Le rendu desktop
  est inchangé.
- **Vue d'ensemble** — les 14 représentations : vendues / libres / **places
  ouvertes** / % de remplissage, plus un rappel discret de la jauge physique de
  la salle, avec sous-total par soirée (19h + 21h) et total sur la série.
  Le « ~ » signale une jauge estimée : le survol en donne la raison et le
  plancher garanti.
  Statut par séance : *Disponible*, *Quasi complet* (≥ 90 %), *Complet* (0 place),
  signalé par une icône **et** un libellé, jamais par la couleur seule.
- **Évolution dans le temps** — courbes des places encore disponibles :
  total de la série, par soirée (7 courbes), ou les deux séances d'une soirée choisie.
- Date et heure du dernier relevé affichées en tête (fuseau Europe/Paris).
- S'adapte au thème clair/sombre du système.

Pas d'alertes e-mail : non demandées.
