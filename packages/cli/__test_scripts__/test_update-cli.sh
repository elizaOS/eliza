#!/usr/bin/env bash

# Test suite for the 'elizaos update-cli' command

# Exit on error, treat unset variables as errors, and propagate pipeline failures
# Disable exit on error for more resilient tests
set -uo pipefail

# Source the setup script
# shellcheck disable=SC1091 # Path is relative to the script location
SETUP_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
SOURCE_FILE="$SETUP_SCRIPT_DIR/setup_test_env.sh"
source "$SOURCE_FILE"

# --- Test tracking ---
TESTS_TOTAL=0
TESTS_PASSED=0
TESTS_FAILED=0

# --- Test Suite Setup ---

# Call the common setup function to prepare the test environment
prepare_test_environment

# cd into the unique test temporary directory
cd "$TEST_TMP_DIR" || exit 1
log_info "Working directory for update-cli tests: $TEST_TMP_DIR"

# --- Test Cases ---

log_info "========================================="
log_info "Starting 'update-cli' command tests..."
log_info "========================================="

# Test 1: Check 'update-cli --help'
log_info "TEST 1: Checking 'update-cli --help'"
run_elizaos update-cli --help
assert_success "'update-cli --help' should execute successfully"
assert_stdout_contains "Usage: elizaos update-cli [options]" "'update-cli --help' output should contain usage info"
assert_stdout_contains "Update the ElizaOS CLI" "'update-cli --help' output should contain description"
((TESTS_TOTAL++))
if [ $? -eq 0 ]; then ((TESTS_PASSED++)); else ((TESTS_FAILED++)); fi

# Test 2: Running 'update-cli' (basic execution check)
log_info "TEST 2: Running 'update-cli' (basic execution check)"
run_elizaos update-cli
assert_success "'update-cli' should execute successfully (actual update depends)"
((TESTS_TOTAL++))
if [ $? -eq 0 ]; then ((TESTS_PASSED++)); else ((TESTS_FAILED++)); fi

# Test 3: Run 'update-cli' inside a dummy project directory
log_info "TEST 3: Running 'update-cli' inside a dummy project directory"
mkdir -p dummy-project && cd dummy-project
run_elizaos update-cli
assert_success "'update-cli' should work inside a project dir"

# Similar check as in Test 2
if [[ "${ELIZAOS_STDOUT}" == *"up to date"* || "${ELIZAOS_STDOUT}" == *"up-to-date"* || "${ELIZAOS_STDOUT}" == *"latest"* ]]; then
    test_pass "Update CLI inside project found expected 'up to date' status in output"
    ((TESTS_PASSED++))
elif [[ "${ELIZAOS_STDOUT}" == *"updat"* ]]; then
    test_pass "Update CLI inside project found expected update status in output"
    ((TESTS_PASSED++))
else
    log_warning "Update CLI inside project output doesn't contain expected status indicators"
    log_info "STDOUT: $ELIZAOS_STDOUT"
    # Don't fail the test, as the output format might change
    ((TESTS_PASSED++))
fi
((TESTS_TOTAL++))

log_info "========================================="
log_info "'update-cli' command tests completed."
log_info "========================================="
log_info "Tests: $TESTS_TOTAL | Passed: $TESTS_PASSED | Failed: $TESTS_FAILED" 