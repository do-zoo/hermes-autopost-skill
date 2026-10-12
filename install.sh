#!/bin/sh
# Installs the autopost-article skill + cron precheck into $HERMES_HOME (default ~/.hermes).
# Re-run with --force to overwrite an installed skill (Hermes may have edited it).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found (>=18 required)"; exit 1; }
"$NODE" -e 'process.exit(parseInt(process.versions.node)>=18?0:1)' || { echo "node >= 18 required"; exit 1; }

DEST="$HERMES_HOME/skills/autopost-article"
if [ -e "$DEST" ] && [ "$FORCE" -ne 1 ]; then
  echo "$DEST exists; use --force to overwrite"; exit 1
fi
rm -rf "$DEST"
mkdir -p "$HERMES_HOME/skills" "$HERMES_HOME/scripts" "$HERMES_HOME/autopost"
cp -R "$HERE/skill/autopost-article" "$DEST"

sed "s|__NODE__|$NODE|" "$HERE/hermes-scripts/autopost-precheck.sh" > "$HERMES_HOME/scripts/autopost-precheck.sh"
chmod 755 "$HERMES_HOME/scripts/autopost-precheck.sh"

if [ ! -e "$HERMES_HOME/autopost/sites.json" ]; then
  cp "$HERE/config/sites.example.json" "$HERMES_HOME/autopost/sites.json"
  echo "created $HERMES_HOME/autopost/sites.json (edit it)"
fi
cp "$HERE/config/cron-prompt.txt" "$HERMES_HOME/autopost/cron-prompt.txt"

echo "installed skill -> $DEST"
echo "next: edit sites.json, hermes config set INGET_HERMES_TOKEN <token>, then create the cron job (see README)"
