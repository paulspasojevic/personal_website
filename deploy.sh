#!/usr/bin/env bash
#
# Deploy to paulspasojevic.com.
#
# Connection details live in ~/.ssh/config under the alias below, so no
# hostname, username or key path is committed here. See README.
#
# Shell access is disabled on the cPanel account, so rsync can't run
# remotely — this uploads over SFTP instead. Consequence: files are added
# and overwritten, never deleted. If you remove a file locally, delete it
# on the server by hand.
#
#   ./deploy.sh          upload
#   ./deploy.sh --dry    list what would upload, touch nothing

set -euo pipefail

HOST="paulspasojevic-deploy"
REMOTE="public_html"

cd "$(dirname "$0")"

# Everything the site needs, and nothing else — no .git, no README, no
# deploy.sh itself.
FILES=(index.html)
for f in css/* js/* data/* fonts/*; do
  [ -f "$f" ] && FILES+=("$f")
done

if [ "${1:-}" = "--dry" ]; then
  echo "Would upload ${#FILES[@]} files to $HOST:$REMOTE/"
  printf '  %s\n' "${FILES[@]}"
  exit 0
fi

BATCH=$(mktemp)
trap 'rm -f "$BATCH"' EXIT

# "-" prefix means carry on if the directory already exists.
for d in css js data fonts; do
  echo "-mkdir $REMOTE/$d"
done >>"$BATCH"

for f in "${FILES[@]}"; do
  echo "put $f $REMOTE/$f"
done >>"$BATCH"

echo "Uploading ${#FILES[@]} files to $HOST:$REMOTE/ ..."
sftp -b "$BATCH" "$HOST" >/dev/null
echo "Done. https://paulspasojevic.com/"
