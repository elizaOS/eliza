#!/usr/bin/env bash
# Regenerate Playwright visual-regression baselines for @elizaos/os-homepage.
#
# Usage:
#   bash packages/os-homepage/scripts/regenerate-baselines.sh
#
# Snapshots land under packages/os-homepage/tests/visual.spec.ts-snapshots/
# and are platform-suffixed (chromium-darwin / chromium-linux). Run this on
# each target platform to refresh that platform's snapshots, then commit the
# resulting PNGs.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."
exec bun run test:e2e -- --update-snapshots
