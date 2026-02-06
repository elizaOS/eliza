#!/usr/bin/env bash
set -euo pipefail

cd /repo

export MILAIDY_STATE_DIR="/tmp/milaidy-test"
export MILAIDY_CONFIG_PATH="${MILAIDY_STATE_DIR}/milaidy.json"

echo "==> Build"
pnpm build

echo "==> Seed state"
mkdir -p "${MILAIDY_STATE_DIR}/credentials"
mkdir -p "${MILAIDY_STATE_DIR}/agents/main/sessions"
echo '{}' >"${MILAIDY_CONFIG_PATH}"
echo 'creds' >"${MILAIDY_STATE_DIR}/credentials/marker.txt"
echo 'session' >"${MILAIDY_STATE_DIR}/agents/main/sessions/sessions.json"

echo "==> Reset (config+creds+sessions)"
pnpm milaidy reset --scope config+creds+sessions --yes --non-interactive

test ! -f "${MILAIDY_CONFIG_PATH}"
test ! -d "${MILAIDY_STATE_DIR}/credentials"
test ! -d "${MILAIDY_STATE_DIR}/agents/main/sessions"

echo "==> Recreate minimal config"
mkdir -p "${MILAIDY_STATE_DIR}/credentials"
echo '{}' >"${MILAIDY_CONFIG_PATH}"

echo "==> Uninstall (state only)"
pnpm milaidy uninstall --state --yes --non-interactive

test ! -d "${MILAIDY_STATE_DIR}"

echo "OK"
