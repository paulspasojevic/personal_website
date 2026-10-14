#!/usr/bin/env bash
#
# Deploy to paulspasojevic.com, or with --recipes to its recipes subdomain.
#
# Connection details live in ~/.ssh/config under the alias below, so no
# hostname, username or key path is committed here. See README.
#
# Shell access is disabled on the cPanel account, so rsync can't run
# remotely — this uploads over SFTP instead. Consequence: files are added
# and overwritten, never deleted. If you remove a file locally, delete it
# on the server by hand.
#
#   ./deploy.sh                   upload the main site
#   ./deploy.sh --dry             list what would upload, touch nothing
#   ./deploy.sh --recipes         upload recipes.paulspasojevic.com
#   ./deploy.sh --recipes --dry

set -euo pipefail

HOST="paulspasojevic-deploy"

cd "$(dirname "$0")"

RECIPES=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --recipes) RECIPES=1 ;;
    --dry)     DRY=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# FILES holds "local remote" pairs; DIRS the remote directories to create.
FILES=()
DIRS=()

if [ "$RECIPES" = 1 ]; then
  # The subdomain's document root, relative to the account's home directory.
  # Must match what cPanel shows under Domains for recipes.paulspasojevic.com.
  REMOTE="recipes"
  URL="https://recipes.paulspasojevic.com/"

  # Validates every recipe and rebuilds data/index.json. Exits non-zero on a
  # bad recipe, which set -e turns into "upload nothing".
  python3 -I recipes/build_index.py

  DIRS=(css js data fonts)
  FILES+=("recipes/index.html index.html")
  for f in recipes/css/* recipes/js/* recipes/data/*.json; do
    FILES+=("$f ${f#recipes/}")
  done
  # Only the two faces the recipes page uses, from the main site's fonts/ —
  # recipes/fonts is a symlink to it for local previewing. OFL must ship
  # with them.
  for f in geist-mono-variable.woff2 geist-pixel-circle.woff2 OFL.txt; do
    FILES+=("fonts/$f fonts/$f")
  done
else
  REMOTE="public_html"
  URL="https://paulspasojevic.com/"

  # Everything the site needs, and nothing else — no .git, no README, no
  # deploy.sh itself.
  #
  # map/ is the background test page, not part of the site: nothing under
  # index.html links to it and it's noindex. It ships so it can be opened on a
  # phone or a second laptop. To stop publishing it, drop "map" from DIRS
  # below — and remember this script never deletes, so also remove
  # public_html/map on the server by hand.
  DIRS=(css js data fonts map)

  FILES+=("index.html index.html")
  for d in "${DIRS[@]}"; do
    for f in "$d"/*; do
      [ -f "$f" ] && FILES+=("$f $f")
    done
  done
fi

if [ "$DRY" = 1 ]; then
  echo "Would upload ${#FILES[@]} files to $HOST:$REMOTE/"
  for pair in "${FILES[@]}"; do
    printf '  %s\n' "${pair#* }"
  done
  exit 0
fi

BATCH=$(mktemp)
trap 'rm -f "$BATCH"' EXIT

# "-" prefix means carry on if the directory already exists.
for d in "${DIRS[@]}"; do
  echo "-mkdir $REMOTE/$d"
done >>"$BATCH"

for pair in "${FILES[@]}"; do
  echo "put ${pair% *} $REMOTE/${pair#* }"
done >>"$BATCH"

echo "Uploading ${#FILES[@]} files to $HOST:$REMOTE/ ..."
sftp -b "$BATCH" "$HOST" >/dev/null
echo "Done. $URL"
