#!/bin/bash

echo "🧪 Running Comprehensive API Tests"
echo "=================================="
echo ""

# Function to run a test and check result
run_test() {
    local test_name=$1
    local test_command=$2
    
    echo "📝 Running: $test_name"
    echo "-----------------------------------"
    
    if eval "$test_command"; then
        echo "✅ $test_name: PASSED"
        echo ""
        return 0
    else
        echo "❌ $test_name: FAILED"
        echo ""
        return 1
    fi
}

# Track overall test results
FAILED_TESTS=0

# Change to the CLI package directory
cd "$(dirname "$0")/../../.."

# Kill any existing servers on test ports
echo "🧹 Cleaning up any existing test servers..."
lsof -ti:3457 | xargs kill -9 2>/dev/null || true
lsof -ti:3458 | xargs kill -9 2>/dev/null || true
echo ""

# Run API Route Tests
if ! run_test "API Route Tests" "npx tsx src/server/test/api-routes.test.ts"; then
    ((FAILED_TESTS++))
fi

# Wait a moment between tests
sleep 2

# Run Frontend Loading Tests
if ! run_test "Frontend Loading Tests" "npx tsx src/server/test/frontend-loading-test.ts"; then
    ((FAILED_TESTS++))
fi

# Run Diagnostic Tests
if ! run_test "Frontend Diagnostic Tests" "npx tsx src/server/test/diagnose-frontend-loading.ts"; then
    ((FAILED_TESTS++))
fi

# Run Verification Tests
if ! run_test "Frontend Fix Verification" "npx tsx src/server/test/verify-frontend-fix.ts"; then
    ((FAILED_TESTS++))
fi

# Summary
echo ""
echo "📊 Test Summary"
echo "==============="
if [ $FAILED_TESTS -eq 0 ]; then
    echo "✅ All tests passed!"
else
    echo "❌ $FAILED_TESTS test(s) failed"
    exit 1
fi 