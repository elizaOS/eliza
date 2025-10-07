#!/bin/bash

# Run integration tests in smaller batches to reduce resource usage in CI
# This helps prevent memory exhaustion and timeouts

set -e

echo "Running plugin-sql integration tests in batches..."

# Define test groups to run sequentially
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

# PostgreSQL tests (if available)
BATCH8=(
    "src/__tests__/integration/postgres-adapter.test.ts"
    "src/__tests__/integration/postgres-init.test.ts"
    "src/__tests__/integration/pg-adapter-integration.test.ts"
)

run_batch() {
    local batch_name=$1
    shift
    local tests=("$@")

    echo "Running batch: $batch_name"
    echo "Tests: ${tests[*]}"

    # Run tests with timeout and bail on first failure to prevent hanging
    if ! bun test "${tests[@]}" --timeout=120000 --bail=1; then
        echo "❌ Batch $batch_name failed"
        return 1
    fi

    echo "✅ Batch $batch_name completed successfully"

    # Brief pause between batches to allow cleanup
    sleep 2
}

# Track overall success
OVERALL_SUCCESS=true

# Run each batch
if ! run_batch "Core Tests" "${BATCH1[@]}"; then
    OVERALL_SUCCESS=false
fi

if ! run_batch "Entity Tests" "${BATCH2[@]}"; then
    OVERALL_SUCCESS=false
fi

if ! run_batch "Component Tests" "${BATCH3[@]}"; then
    OVERALL_SUCCESS=false
fi

if ! run_batch "Infrastructure Tests" "${BATCH4[@]}"; then
    OVERALL_SUCCESS=false
fi

if ! run_batch "Integration Tests" "${BATCH5[@]}"; then
    OVERALL_SUCCESS=false
fi

if ! run_batch "Method Tests" "${BATCH6[@]}"; then
    OVERALL_SUCCESS=false
fi

if ! run_batch "Utility Tests" "${BATCH7[@]}"; then
    OVERALL_SUCCESS=false
fi

# Only run PostgreSQL tests if POSTGRES_URL is set
if [ -n "$POSTGRES_URL" ]; then
    if ! run_batch "PostgreSQL Tests" "${BATCH8[@]}"; then
        OVERALL_SUCCESS=false
    fi
else
    echo "ℹ️  Skipping PostgreSQL tests (POSTGRES_URL not set)"
fi

# Final result
if [ "$OVERALL_SUCCESS" = true ]; then
    echo "🎉 All test batches completed successfully!"
    exit 0
else
    echo "💥 One or more test batches failed"
    exit 1
fi
