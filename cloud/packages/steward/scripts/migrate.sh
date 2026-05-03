#!/bin/bash
set -euo pipefail

# =============================================================================
# Steward Migration Runner
# Usage: ./scripts/migrate.sh [--dry-run]
# Requires: DATABASE_URL env var or reads from /opt/steward/.env
#
# NOTE: This script runs ALL numbered SQL files every time (no tracking table).
# This is safe because all Drizzle-generated migrations use idempotent DDL
# (CREATE TABLE IF NOT EXISTS, DO $$ blocks with existence checks, etc.).
# Re-running against an already-migrated database is a no-op for each file.
#
# If you add custom migrations, ensure they are also idempotent.
# =============================================================================

DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h|--help)
      echo "Usage: $0 [--dry-run]"
      echo "  --dry-run  Print SQL files that would run, without executing"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg"
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Resolve DATABASE_URL
# ---------------------------------------------------------------------------
if [[ -z "${DATABASE_URL:-}" ]]; then
  ENV_FILE="${ENV_FILE:-/opt/steward/.env}"
  if [[ -f "$ENV_FILE" ]]; then
    DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d'=' -f2-)
    DATABASE_URL="${DATABASE_URL#\"}"
    DATABASE_URL="${DATABASE_URL%\"}"
    DATABASE_URL="${DATABASE_URL#\'}"
    DATABASE_URL="${DATABASE_URL%\'}"
    export DATABASE_URL
    echo "[migrate] Loaded DATABASE_URL from $ENV_FILE"
  fi
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[migrate] ERROR: DATABASE_URL not set and not found in .env"
  exit 1
fi

# ---------------------------------------------------------------------------
# Find migration directory (relative to repo root or /opt/steward)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_DIR="$REPO_ROOT/packages/db/drizzle"

if [[ ! -d "$MIGRATION_DIR" ]]; then
  echo "[migrate] ERROR: Migration directory not found: $MIGRATION_DIR"
  exit 1
fi

# ---------------------------------------------------------------------------
# Collect numbered migration files (0000_*.sql through 9999_*.sql), sorted
# ---------------------------------------------------------------------------
MIGRATIONS=()
while IFS= read -r f; do
  MIGRATIONS+=("$f")
done < <(find "$MIGRATION_DIR" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]_*.sql' | sort)

if [[ ${#MIGRATIONS[@]} -eq 0 ]]; then
  echo "[migrate] No migration files found in $MIGRATION_DIR"
  exit 0
fi

echo "[migrate] Found ${#MIGRATIONS[@]} migration(s)"
echo ""

# ---------------------------------------------------------------------------
# Run migrations
# ---------------------------------------------------------------------------
PASSED=0
FAILED=0

for sql_file in "${MIGRATIONS[@]}"; do
  name="$(basename "$sql_file")"

  if $DRY_RUN; then
    echo "[dry-run] Would execute: $name"
    echo "---"
    head -5 "$sql_file"
    echo "..."
    echo ""
    PASSED=$((PASSED + 1))
    continue
  fi

  echo -n "[migrate] $name ... "

  if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$sql_file" > /tmp/migrate_out.log 2>&1; then
    echo -e "\033[32mOK\033[0m"
    PASSED=$((PASSED + 1))
  else
    echo -e "\033[31mFAILED\033[0m"
    cat /tmp/migrate_out.log
    FAILED=$((FAILED + 1))
    echo ""
    echo "[migrate] ABORTING: migration $name failed"
    echo "[migrate] Results: $PASSED passed, $FAILED failed"
    exit 1
  fi
done

echo ""
echo "[migrate] Done: $PASSED passed, $FAILED failed"
exit $FAILED
