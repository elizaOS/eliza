#!/bin/bash

# Integration tests runner
# Usage:
#   ./scripts/run-integration-tests.sh             # PGLite only
#   ./scripts/run-integration-tests.sh --postgres  # Include real PostgreSQL tests (auto-start Docker)
#   POSTGRES_URL=... ./scripts/run-integration-tests.sh  # Use existing PostgreSQL (CI mode)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$PACKAGE_DIR/docker-compose.test.yml"

USE_POSTGRES=false
POSTGRES_STARTED=false

# Auto-enable PostgreSQL tests if POSTGRES_URL is already set (CI mode)
if [ -n "$POSTGRES_URL" ]; then
    USE_POSTGRES=true
fi

# Parse arguments
for arg in "$@"; do
    case $arg in
        --postgres)
            USE_POSTGRES=true
            shift
            ;;
    esac
done

cleanup() {
    if [ "$POSTGRES_STARTED" = true ]; then
        echo "🧹 Stopping PostgreSQL..."
        docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
    fi
}

trap cleanup EXIT

start_postgres() {
    # Skip if POSTGRES_URL already set (CI provides PostgreSQL)
    if [ -n "$POSTGRES_URL" ]; then
        echo "✅ Using existing PostgreSQL: $POSTGRES_URL"
        return 0
    fi

    echo "🐘 Starting PostgreSQL via Docker..."
    docker compose -f "$COMPOSE_FILE" up -d

    echo "⏳ Waiting for PostgreSQL to be ready..."
    for i in {1..30}; do
        if docker exec plugin-sql-test-postgres pg_isready -U postgres > /dev/null 2>&1; then
            echo "✅ PostgreSQL is ready"
            POSTGRES_STARTED=true
            export POSTGRES_URL="postgresql://eliza_test:test123@localhost:5432/eliza_test"
            return 0
        fi
        echo -n "."
        sleep 1
    done
    echo ""
    echo "❌ PostgreSQL failed to start"
    return 1
}

# Define test groups (PGLite)
BATCH1=(
    "src/__tests__/integration/memory.test.ts"
    "src/__tests__/integration/cache.test.ts"
    "src/__tests__/integration/embedding.test.ts"
)

BATCH2=(
    "src/__tests__/integration/agent.test.ts"
    "src/__tests__/integration/entity.test.ts"
    "src/__tests__/integration/entity-crud.test.ts"
)

BATCH3=(
    "src/__tests__/integration/component.test.ts"
    "src/__tests__/integration/relationship.test.ts"
    "src/__tests__/integration/room.test.ts"
)

BATCH4=(
    "src/__tests__/integration/world.test.ts"
    "src/__tests__/integration/log.test.ts"
    "src/__tests__/integration/messaging.test.ts"
)

BATCH5=(
    "src/__tests__/integration/base-comprehensive.test.ts"
    "src/__tests__/integration/base-adapter-methods.test.ts"
    "src/__tests__/integration/cascade-delete.test.ts"
)

BATCH6=(
    "src/__tests__/integration/entity-methods.test.ts"
    "src/__tests__/integration/participant.test.ts"
    "src/__tests__/integration/task.test.ts"
)

BATCH7=(
    "src/__tests__/integration/utils.test.ts"
    "src/__tests__/integration/schema-factory.test.ts"
)

# PostgreSQL-specific tests
BATCH_POSTGRES=(
    "src/__tests__/integration/postgres/pglite-adapter.test.ts"
    "src/__tests__/integration/postgres/postgres-init.test.ts"
    "src/__tests__/integration/postgres/pg-adapter-integration.test.ts"
)

BATCH_RLS=(
    "src/__tests__/integration/postgres/rls-entity.test.ts"
    "src/__tests__/integration/postgres/rls-server.test.ts"
    "src/__tests__/integration/postgres/rls-logs.test.ts"
    "src/__tests__/integration/postgres/rls-message-server-agents.test.ts"
)

run_batch() {
    local batch_name=$1
    shift
    local tests=("$@")

    echo ""
    echo "📦 Running: $batch_name"

    if ! bun test "${tests[@]}" --timeout=120000 --bail=1; then
        echo "❌ $batch_name failed"
        return 1
    fi

    echo "✅ $batch_name passed"
    sleep 1
}

# Run tests sequentially (one file at a time) - needed for RLS tests
# where rls-entity.test.ts must complete before others run
run_sequential() {
    local batch_name=$1
    shift
    local tests=("$@")

    echo ""
    echo "📦 Running: $batch_name (sequential)"

    for test_file in "${tests[@]}"; do
        echo "   → $(basename "$test_file")"
        if ! bun test "$test_file" --timeout=120000; then
            echo "❌ $batch_name failed at $test_file"
            return 1
        fi
    done

    echo "✅ $batch_name passed"
    sleep 1
}

echo "🧪 Running plugin-sql integration tests"
if [ "$USE_POSTGRES" = true ]; then
    echo "   Mode: PGLite + PostgreSQL"
else
    echo "   Mode: PGLite only"
fi
echo ""

OVERALL_SUCCESS=true

# Core tests (PGLite)
run_batch "Core Tests" "${BATCH1[@]}" || OVERALL_SUCCESS=false
run_batch "Entity Tests" "${BATCH2[@]}" || OVERALL_SUCCESS=false
run_batch "Component Tests" "${BATCH3[@]}" || OVERALL_SUCCESS=false
run_batch "Infrastructure Tests" "${BATCH4[@]}" || OVERALL_SUCCESS=false
run_batch "Integration Tests" "${BATCH5[@]}" || OVERALL_SUCCESS=false
run_batch "Method Tests" "${BATCH6[@]}" || OVERALL_SUCCESS=false
run_batch "Utility Tests" "${BATCH7[@]}" || OVERALL_SUCCESS=false

# PostgreSQL tests (if requested or POSTGRES_URL set)
if [ "$USE_POSTGRES" = true ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🐘 PostgreSQL Tests"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if start_postgres; then
        run_batch "PostgreSQL Adapter Tests" "${BATCH_POSTGRES[@]}" || OVERALL_SUCCESS=false
        # RLS tests must run sequentially - rls-entity.test.ts creates schema and installs RLS
        # that other RLS tests depend on
        run_sequential "RLS Tests" "${BATCH_RLS[@]}" || OVERALL_SUCCESS=false
    else
        OVERALL_SUCCESS=false
    fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$OVERALL_SUCCESS" = true ]; then
    echo "🎉 All tests passed!"
    exit 0
else
    echo "💥 Some tests failed"
    exit 1
fi
