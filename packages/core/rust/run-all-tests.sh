#!/bin/bash
# Comprehensive test runner for elizaOS Rust implementation

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_RUST="$SCRIPT_DIR"
PLUGIN_SQL_RUST="$SCRIPT_DIR/../../plugin-sql/rust"

echo "=========================================="
echo "  elizaOS Rust Implementation Test Suite"
echo "=========================================="
echo ""

TOTAL_PASSED=0
TOTAL_FAILED=0
TOTAL_SKIPPED=0

run_rust_tests() {
    local package_name=$1
    local package_path=$2

    echo ""
    echo "--------------------------------------------"
    echo "  Testing: $package_name"
    echo "--------------------------------------------"

    if [ ! -d "$package_path" ]; then
        echo "  [SKIP] Package not found: $package_path"
        ((TOTAL_SKIPPED++))
        return
    fi

    cd "$package_path"

    # Build
    echo "  Building..."
    if cargo build 2>&1 | tail -3; then
        echo "  [OK] Build successful"
    else
        echo "  [FAIL] Build failed"
        ((TOTAL_FAILED++))
        return
    fi

    # Test
    echo "  Running tests..."
    local test_output
    test_output=$(cargo test 2>&1)
    local test_exit=$?

    # Parse results
    local passed=$(echo "$test_output" | grep -o "[0-9]* passed" | head -1 | grep -o "[0-9]*" || echo "0")
    local failed=$(echo "$test_output" | grep -o "[0-9]* failed" | head -1 | grep -o "[0-9]*" || echo "0")
    local ignored=$(echo "$test_output" | grep -o "[0-9]* ignored" | head -1 | grep -o "[0-9]*" || echo "0")

    if [ "$test_exit" -eq 0 ]; then
        echo "  [OK] Tests passed: $passed (ignored: $ignored)"
        TOTAL_PASSED=$((TOTAL_PASSED + passed))
        TOTAL_SKIPPED=$((TOTAL_SKIPPED + ignored))
    else
        echo "  [FAIL] Tests failed: $failed (passed: $passed)"
        TOTAL_FAILED=$((TOTAL_FAILED + failed))
        TOTAL_PASSED=$((TOTAL_PASSED + passed))
    fi

    # Clippy
    echo "  Running clippy..."
    if cargo clippy 2>&1 | grep -q "error\["; then
        echo "  [WARN] Clippy has errors"
    else
        echo "  [OK] Clippy passed"
    fi

    # Format check
    echo "  Checking format..."
    if cargo fmt --check 2>&1 | head -1 | grep -q "Diff"; then
        echo "  [WARN] Format check failed (run 'cargo fmt')"
    else
        echo "  [OK] Format check passed"
    fi
}

run_python_tests() {
    echo ""
    echo "--------------------------------------------"
    echo "  Testing: Python serialization tests"
    echo "--------------------------------------------"

    local python_test_dir="$CORE_RUST/__tests__/python"
    if [ ! -d "$python_test_dir" ]; then
        echo "  [SKIP] Python tests not found"
        ((TOTAL_SKIPPED++))
        return
    fi

    cd "$python_test_dir"

    if command -v python3 &> /dev/null; then
        local test_output
        test_output=$(python3 -m unittest test_wasm_bindings 2>&1)
        local test_exit=$?

        local passed=$(echo "$test_output" | grep -o "Ran [0-9]* test" | grep -o "[0-9]*" || echo "0")
        local skipped=$(echo "$test_output" | grep -o "skipped=[0-9]*" | grep -o "[0-9]*" || echo "0")

        if [ "$test_exit" -eq 0 ]; then
            echo "  [OK] Python tests passed: $passed (skipped: $skipped)"
            TOTAL_PASSED=$((TOTAL_PASSED + passed - skipped))
            TOTAL_SKIPPED=$((TOTAL_SKIPPED + skipped))
        else
            echo "  [FAIL] Python tests failed"
            TOTAL_FAILED=$((TOTAL_FAILED + 1))
        fi
    else
        echo "  [SKIP] Python3 not available"
        ((TOTAL_SKIPPED++))
    fi
}

# Run all test suites
run_rust_tests "elizaos" "$CORE_RUST"
run_rust_tests "elizaos-plugin-sql" "$PLUGIN_SQL_RUST"
run_python_tests

# Summary
echo ""
echo "=========================================="
echo "  Test Summary"
echo "=========================================="
echo "  Passed:  $TOTAL_PASSED"
echo "  Failed:  $TOTAL_FAILED"
echo "  Skipped: $TOTAL_SKIPPED"
echo "=========================================="

if [ "$TOTAL_FAILED" -gt 0 ]; then
    echo ""
    echo "  [FAIL] Some tests failed!"
    exit 1
else
    echo ""
    echo "  [OK] All tests passed!"
    exit 0
fi

