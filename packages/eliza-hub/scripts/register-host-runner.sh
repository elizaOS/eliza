#!/usr/bin/env bash
set -euo pipefail

if [[ "${ALLOW_LOCAL_HOST_RUNNER:-}" != "true" ]]; then
  echo "error: host runner is local-only; set ALLOW_LOCAL_HOST_RUNNER=true to acknowledge the risk" >&2
  exit 2
fi

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <registration-token>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="${ROOT}/bin/forgejo-runner-12.12.0-linux-amd64"

exec "${RUNNER}" register \
  --no-interactive \
  --instance "http://localhost:3000" \
  --token "$1" \
  --name "eliza-local-host" \
  --labels "ubuntu-latest:host,self-hosted:host" \
  --config "${ROOT}/runner/host-data/config.yml"
