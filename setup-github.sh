#!/usr/bin/env bash
#
# Crée le dépôt GitHub, pousse le code, et applique les deux réglages sans
# lesquels l'automatisation ne tourne pas :
#   - permissions d'écriture pour les workflows (sinon le commit quotidien → 403)
#   - GitHub Pages en source « GitHub Actions »
#
# Prérequis : la CLI GitHub authentifiée.
#   brew install gh && gh auth login
#
# Usage :  ./setup-github.sh [nom-du-depot]
#
set -euo pipefail

REPO_NAME="${1:-alliance-splendid}"
VISIBILITY="--public"     # passer à --private si vous changez d'avis

cd "$(dirname "$0")"

info()  { printf '\033[1;34m›\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# --- vérifications -----------------------------------------------------------

command -v gh >/dev/null 2>&1 || die "La CLI GitHub (gh) n'est pas installée.  brew install gh"
gh auth status >/dev/null 2>&1 || die "gh n'est pas authentifié.  gh auth login"
[ -d .git ] || die "Ce dossier n'est pas un dépôt git."
git rev-parse HEAD >/dev/null 2>&1 || die "Aucun commit dans ce dépôt."

OWNER="$(gh api user --jq .login)"
SLUG="$OWNER/$REPO_NAME"
info "Compte GitHub : $OWNER"

# --- 1. le dépôt -------------------------------------------------------------

if gh repo view "$SLUG" >/dev/null 2>&1; then
  ok "Le dépôt $SLUG existe déjà — on réutilise."
  git remote get-url origin >/dev/null 2>&1 \
    || git remote add origin "https://github.com/$SLUG.git"
else
  info "Création de ${SLUG}…"
  gh repo create "$REPO_NAME" $VISIBILITY \
    --source=. --remote=origin \
    --description "Suivi quotidien des ventes — Les Doublages improvisés au Théâtre du Splendid"
  ok "Dépôt créé."
fi

# --- 2. pousser --------------------------------------------------------------

BRANCH="$(git branch --show-current)"
info "Push de la branche ${BRANCH}…"
git push -u origin "$BRANCH"
ok "Code poussé."

# --- 3. autoriser les workflows à committer ----------------------------------
# Sans ça, le `git push` du job de collecte échoue avec une erreur 403.

info "Passage des workflows en écriture…"
gh api -X PUT "repos/$SLUG/actions/permissions/workflow" \
  -f default_workflow_permissions=write \
  -F can_approve_pull_request_reviews=false >/dev/null
ok "Workflows autorisés à committer."

# --- 4. activer GitHub Pages -------------------------------------------------
# build_type=workflow => la source est GitHub Actions (et non une branche).

info "Activation de GitHub Pages…"
if gh api "repos/$SLUG/pages" >/dev/null 2>&1; then
  gh api -X PUT "repos/$SLUG/pages" -f build_type=workflow >/dev/null
  ok "Pages déjà actif — source repassée sur GitHub Actions."
else
  gh api -X POST "repos/$SLUG/pages" -f build_type=workflow >/dev/null \
    && ok "Pages activé." \
    || die "Activation de Pages refusée. Sur un dépôt privé, Pages exige un plan Team/Enterprise. À faire à la main : Settings → Pages → Source : GitHub Actions."
fi

# --- 5. premier relevé -------------------------------------------------------

info "Déclenchement d'une première collecte…"
gh workflow run collect.yml >/dev/null 2>&1 \
  && ok "Collecte lancée." \
  || info "Lancement automatique impossible (le workflow doit d'abord être indexé par GitHub). Relancez dans une minute :  gh workflow run collect.yml"

# --- terminé -----------------------------------------------------------------

echo
ok "Terminé."
echo "  Dépôt      : https://github.com/$SLUG"
echo "  Actions    : https://github.com/$SLUG/actions"
echo "  Dashboard  : https://$(echo "$OWNER" | tr '[:upper:]' '[:lower:]').github.io/$REPO_NAME/"
echo
echo "  Le dashboard apparaît une fois le workflow « Publier le dashboard » terminé"
echo "  (première fois : comptez une à deux minutes)."
