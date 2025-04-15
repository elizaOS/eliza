#!/usr/bin/env bash

# Test suite for the 'elizaos start' command (primarily server verification)

# Exit on error, treat unset variables as errors, and propagate pipeline failures
set -euo pipefail

# Source the setup script
# shellcheck disable=SC1091 # Path is relative to the script location
SETUP_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
SOURCE_FILE="$SETUP_SCRIPT_DIR/setup_test_env.sh"
source "$SOURCE_FILE"

# --- Test Suite Setup ---

# Call the common setup function to prepare the test environment
prepare_test_environment

# The test server is managed by run_cli_tests.sh and its URL is in TEST_SERVER_URL
if [ -z "${TEST_SERVER_URL:-}" ]; then
    log_error "TEST_SERVER_URL environment variable is not set. This script expects the server to be running."
    exit 1
fi

log_info "========================================="
log_info "Starting 'start' command tests (server verification)..."
log_info "Using server URL: $TEST_SERVER_URL"
log_info "========================================="

# --- Test Cases ---

# Test 1: Check 'start --help'
log_info "TEST 1: Checking 'start --help'"
# Run help in the project root or a temp dir, doesn't need project context
run_elizaos start --help
assert_success "'start --help' should execute successfully"
assert_stdout_contains "Usage: elizaos start [options]" "'start --help' output should contain usage info"

# Test 2: Verify the test server (started by run_cli_tests.sh) is responding
log_info "TEST 2: Checking if test server is responding at $TEST_SERVER_URL/api/status"
if curl --silent --fail "$TEST_SERVER_URL/api/status" > /dev/null 2>&1; then
    test_pass "Test server responded successfully to status check"
else
    test_fail "Test server at $TEST_SERVER_URL did not respond to status check"
    # Optionally try to get server logs from the main runner's log file
    SERVER_LOG_FILE="$TEST_TMP_DIR_BASE/eliza_test_server.log"
    if [ -f "$SERVER_LOG_FILE" ]; then
        log_error "Last 20 lines of server log ($SERVER_LOG_FILE):"
        tail -n 20 "$SERVER_LOG_FILE" >&2
    fi
    exit 1 # Fail fast if server isn't running
fi

# Test 3: Verify the API endpoint for agents is available
log_info "TEST 3: Checking agent API endpoint ($TEST_SERVER_URL/api/agents)"
if curl --silent --fail --show-error "$TEST_SERVER_URL/api/agents" > /dev/null 2>&1; then
    test_pass "Agent API endpoint responded successfully"
else
    test_fail "Agent API endpoint ($TEST_SERVER_URL/api/agents) failed"
    exit 1
fi

# Test 4: Attempt to run 'elizaos start' again (should fail if port is in use)
# This test assumes the 'start' command tries to use a default port if not specified,
# and that the test server is already using that port or the one specified via PORT env var.
# Note: This test might be unreliable depending on how 'start' handles port conflicts.
# log_info "TEST 4: Attempting to run 'elizaos start' again (expecting port conflict)"
# ( 
#   # Run in a subshell within a temporary project context if needed
#   cd "$TEST_TMP_DIR"
#   mkdir dummy-start-test && cd dummy-start-test
#   run_elizaos create . --minimal --yes --skip-install
#   # Attempt to start on the *same* port as the test server
#   PORT=${TEST_SERVER_URL##*:} run_elizaos start
#   assert_failure "'elizaos start' on same port should fail due to conflict"
#   assert_stderr_contains "EADDRINUSE" "Error message should indicate port conflict (EADDRINUSE)"
# )

# Note: Starting specific agents is handled by 'test_agent.sh' now.
# Tests for different start modes (e.g., --dev if exists) could be added here,
# but might require more complex server state inspection.

log_info "========================================="
log_info "'start' command tests completed."
log_info "=========================================" 