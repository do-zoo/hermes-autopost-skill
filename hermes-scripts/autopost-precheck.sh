#!/bin/sh
# Cron pre-check for Hermes. Prints {"wakeAgent": false} when nothing is due (no LLM call, no tokens).
# The NODE path below is filled in by install.sh with the absolute node path (cron may run with a bare PATH).
NODE="__NODE__"
[ -x "$NODE" ] || NODE="$(command -v node)"
# Filled in by install.sh: cron scripts run with a sanitized env, so do not rely on inheriting HERMES_HOME.
HERMES_HOME="__HERMES_HOME__"
exec "$NODE" "$HERMES_HOME/skills/autopost-article/scripts/autopost.mjs" precheck "$@"
