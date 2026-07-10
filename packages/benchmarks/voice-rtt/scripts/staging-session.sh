#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec bun run src/staging-session.ts --config=configs/staging-session.json "$@"
