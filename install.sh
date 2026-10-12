#!/bin/sh
# Installs the autopost-article skill + cron precheck into a Hermes profile.
# usage: ./install.sh [--config FILE] [--profile NAME] [--force] [--cron]
# Settings come from config/install.conf (git-ignored; see config/install.conf.example). Flags override the file.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"

CONF="$HERE/config/install.conf"
# first pass: only find --config
prev=""; for a in "$@"; do [ "$prev" = "--config" ] && CONF="$a"; prev="$a"; done

PROFILE=""; INGET_HERMES_TOKEN=""; SITES_FILE=""; CRON_SCHEDULE="every 1h"; CRON_NAME="autopost"
if [ -f "$CONF" ]; then
  # shellcheck disable=SC1090
  . "$CONF"
  echo "config: $CONF"
elif [ "$CONF" != "$HERE/config/install.conf" ]; then
  echo "config file not found: $CONF"; exit 1
fi

FORCE=0; DO_CRON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --cron) DO_CRON=1 ;;
    --config) shift ;;
    --profile) shift; PROFILE="${1:?--profile needs a name}" ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
  shift
done

if [ -n "$PROFILE" ]; then HERMES_HOME="$HOME/.hermes/profiles/$PROFILE"
else HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"; fi
[ -d "$HERMES_HOME" ] || { echo "$HERMES_HOME does not exist (create the profile first: hermes profile create ...)"; exit 1; }
HCMD="hermes"; [ -n "$PROFILE" ] && HCMD="hermes -p $PROFILE"

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

sed -e "s|__NODE__|$NODE|" -e "s|__HERMES_HOME__|$HERMES_HOME|" "$HERE/hermes-scripts/autopost-precheck.sh" > "$HERMES_HOME/scripts/autopost-precheck.sh"
chmod 755 "$HERMES_HOME/scripts/autopost-precheck.sh"

# sites.json: your own file > config/sites.json > example (only if none installed yet)
if [ -z "$SITES_FILE" ]; then
  [ -f "$HERE/config/sites.json" ] && SITES_FILE="$HERE/config/sites.json"
fi
case "$SITES_FILE" in ""|/*) ;; *) SITES_FILE="$HERE/$SITES_FILE" ;; esac
if [ -n "$SITES_FILE" ]; then
  [ -f "$SITES_FILE" ] || { echo "sites file not found: $SITES_FILE"; exit 1; }
  "$NODE" -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!Array.isArray(a)||!a.length)process.exit(1)' "$SITES_FILE" \
    || { echo "sites file must be a non-empty JSON array: $SITES_FILE"; exit 1; }
  cp "$SITES_FILE" "$HERMES_HOME/autopost/sites.json"
  echo "installed sites.json from $SITES_FILE"
elif [ ! -e "$HERMES_HOME/autopost/sites.json" ]; then
  cp "$HERE/config/sites.example.json" "$HERMES_HOME/autopost/sites.json"
  echo "created $HERMES_HOME/autopost/sites.json from example (edit it, or put your own in config/sites.json)"
fi
cp "$HERE/config/cron-prompt.txt" "$HERMES_HOME/autopost/cron-prompt.txt"

# Token -> $HERMES_HOME/.env (never echoed, never on a command line)
if [ -n "$INGET_HERMES_TOKEN" ]; then
  ENVF="$HERMES_HOME/.env"
  ( umask 077
    touch "$ENVF"
    grep -v '^INGET_HERMES_TOKEN=' "$ENVF" > "$ENVF.tmp" || true
    printf 'INGET_HERMES_TOKEN=%s\n' "$INGET_HERMES_TOKEN" >> "$ENVF.tmp"
    mv "$ENVF.tmp" "$ENVF" )
  chmod 600 "$ENVF"
  echo "token written to $ENVF"
else
  echo "no token in config; make sure INGET_HERMES_TOKEN is in $HERMES_HOME/.env"
fi

echo "installed skill -> $DEST"

CRON_CMD="$HCMD cron create \"$CRON_SCHEDULE\" \"\$(cat $HERMES_HOME/autopost/cron-prompt.txt)\" --script autopost-precheck.sh --skill autopost-article --name $CRON_NAME --deliver local"
if [ "$DO_CRON" -eq 1 ]; then
  command -v hermes >/dev/null || { echo "hermes not in PATH; run manually: $CRON_CMD"; exit 1; }
  # shellcheck disable=SC2086
  $HCMD cron create "$CRON_SCHEDULE" "$(cat "$HERMES_HOME/autopost/cron-prompt.txt")" \
    --script autopost-precheck.sh --skill autopost-article --name "$CRON_NAME" --deliver local
else
  echo "cron not created. To schedule: re-run with --cron, or:"
  echo "  $CRON_CMD"
fi
echo "next: $HCMD cron status; hermes gateway status (default profile's gateway must serve this profile)"
