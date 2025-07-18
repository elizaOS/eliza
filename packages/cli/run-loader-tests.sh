#!/bin/bash

echo "Running loader tests with bun:test..."
echo ""

# Run the synchronous/asynchronous function tests
echo "Running sync/async tests..."
bun test tests/unit/utils/loader-sync-async.test.ts

echo ""
echo "Running integration tests..."
bun test tests/unit/utils/loader-integration.test.ts

echo ""
echo "Running existing loader tests..."
bun test tests/unit/utils/loader.test.ts

echo ""
echo "All tests completed!"