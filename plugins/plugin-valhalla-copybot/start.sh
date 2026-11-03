#!/bin/sh
cd "$(dirname "$0")" || exit 1
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env. Add your Google AI Studio key, then run this again."
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./.env
set +a
if command -v bun >/dev/null 2>&1; then
  exec bun src/standalone.ts
fi
echo "Install Bun from https://bun.sh or Node.js 24, then run this again."
exit 1
