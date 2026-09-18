#!/usr/bin/env bash
# Real database integration tests. POSTGRES_URL must name a disposable database:
# the test fixtures replace its schemas. Without it, --postgres uses local Docker.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
started=false
cleanup() {
  if "$started"; then docker compose -f "$PACKAGE_DIR/docker-compose.test.yml" down -v; fi
}
trap cleanup EXIT
if [[ "${1:-}" == "--postgres" && -z "${POSTGRES_URL:-}" ]]; then
  docker compose -f "$PACKAGE_DIR/docker-compose.test.yml" up -d --wait
  started=true
  export POSTGRES_URL="postgresql://eliza_test:test123@localhost:5432/eliza_test"
fi
cd "$PACKAGE_DIR/src"
VITEST_LANE=post-merge bunx vitest run __tests__/integration
