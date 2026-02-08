#!/bin/bash
set -e

# Run integration tests for plugin-sql
# Uses PGLite (in-process PostgreSQL) by default - no external database required
#
# For PostgreSQL-specific tests, pass --postgres flag:
#   bash scripts/run-integration-tests.sh --postgres

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ "$1" = "--postgres" ]; then
  echo "Running integration tests with PostgreSQL..."
  POSTGRES_URL="${POSTGRES_URL:-postgresql://localhost:5432/elizaos_test}"
  export POSTGRES_URL
  bun test "$PROJECT_DIR/src/__tests__/integration/" --timeout 30000
else
  echo "Running integration tests with PGLite..."
  bun test "$PROJECT_DIR/src/__tests__/integration/" --timeout 30000
fi
