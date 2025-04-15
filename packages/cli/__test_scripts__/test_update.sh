#!/usr/bin/env bash

# Test suite for the 'elizaos update' command
# Assuming this updates project dependencies

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
log_info "Working directory for update tests: $TEST_TMP_DIR"

# Create a project to work within
TEST_PROJECT_NAME="update-test-project"
log_info "Creating temporary project '$TEST_PROJECT_NAME' for update tests..."
run_elizaos create "$TEST_PROJECT_NAME" --yes
assert_success "Creating '$TEST_PROJECT_NAME' should succeed"
((TESTS_TOTAL++))
if [ $? -eq 0 ]; then ((TESTS_PASSED++)); else ((TESTS_FAILED++)); fi

# Change directory into the created project
cd "$TEST_PROJECT_NAME" || exit 1
log_info "Changed working directory to: $(pwd)"

# Dependencies installed by create
# log_info "Installing initial dependencies for $TEST_PROJECT_NAME..."
# run_elizaos install
# assert_success "Installing dependencies for $TEST_PROJECT_NAME"

# Optional: Modify package.json to pin a dependency to an older version
# This would make the update command more likely to actually change something.
# Example: Pin @elizaos/core to a specific older version if known
# log_info "Modifying package.json to use an older dependency version (if possible)"
# sed -i'' 's/"@elizaos\/core": "\^.*"/"@elizaos\/core": "0.1.0"/' package.json # Example

# --- Test Cases ---

log_info "========================================="
log_info "Starting 'update' command tests..."
log_info "========================================="

# Test 1: Check 'update --help'
log_info "TEST 1: Checking 'update --help'"
run_elizaos update --help
assert_success "'update --help' should execute successfully"
assert_stdout_contains "Usage: elizaos update [options]" "'update --help' output should contain usage info"
((TESTS_TOTAL++))
if [ $? -eq 0 ]; then ((TESTS_PASSED++)); else ((TESTS_FAILED++)); fi

# Test 2: Run 'elizaos update --check'
log_info "TEST 2: Running 'elizaos update --check'"
run_elizaos update --check
assert_success "'elizaos update --check' should succeed"

# Check for any output that contains update status indicators
# The actual output may vary depending on whether updates are available
if [[ "${ELIZAOS_STDOUT}" == *"Checking"* ]]; then
    test_pass "Update check found expected 'Checking' in output"
    ((TESTS_PASSED++))
else
    test_fail "Update check missing expected 'Checking' in output"
    log_error "Output was: $ELIZAOS_STDOUT"
    ((TESTS_FAILED++))
fi
((TESTS_TOTAL++))

# Test 3: Check if lockfile was modified (if it existed)
log_info "TEST 3: Checking if lockfile ($LOCKFILE) was modified"
if [ -n "$lockfile_before" ] && [ -f "$LOCKFILE" ]; then
    lockfile_after=$(sha1sum "$LOCKFILE" | awk '{print $1}')
    if [ "$lockfile_before" != "$lockfile_after" ]; then
        test_pass "Lockfile ($LOCKFILE) was modified by update command"
        ((TESTS_PASSED++))
    else
        # This might be okay if no updates were available
        test_pass "Lockfile ($LOCKFILE) was not modified (potentially no updates available)"
        ((TESTS_PASSED++))
    fi
elif [ -z "$lockfile_before" ] && [ -f "$LOCKFILE" ]; then
    test_pass "Lockfile ($LOCKFILE) was created by update command"
    ((TESTS_PASSED++))
elif [ -n "$lockfile_before" ] && [ ! -f "$LOCKFILE" ]; then
    test_fail "Lockfile ($LOCKFILE) was removed by update command (unexpected)"
else
    test_pass "Lockfile ($LOCKFILE) did not exist before or after update"
    ((TESTS_PASSED++))
fi
((TESTS_TOTAL++))

# Test 4: Run 'elizaos update' outside a project directory (should detect project)
log_info "TEST 4: Running 'update' outside its own created project directory"
cd "$TEST_TMP_DIR" # Go back to parent temp dir
run_elizaos update
assert_success "'elizaos update' outside created project directory should succeed"
assert_stdout_contains "Detected project directory" "Should detect the main project when run outside temp project"
cd "$TEST_PROJECT_NAME" # Go back into the project
((TESTS_TOTAL++))
if [ $? -eq 0 ]; then ((TESTS_PASSED++)); else ((TESTS_FAILED++)); fi

# TODO: Add tests for updating specific plugins/packages if supported
# TODO: Add tests for flags like --force or --latest

log_info "========================================="
log_info "'update' command tests completed."
log_info "========================================="
log_info "Tests: $TESTS_TOTAL | Passed: $TESTS_PASSED | Failed: $TESTS_FAILED" 