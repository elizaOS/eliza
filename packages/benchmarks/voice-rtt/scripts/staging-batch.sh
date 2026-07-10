#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec bun run src/staging-batch.ts --config=configs/staging-batch.json "$@"
