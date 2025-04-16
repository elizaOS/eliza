#!/usr/bin/env bash

# Test suite for the 'elizaos env' command group

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

# Check if the test server URL is available (needed for env commands)
if [ -z "${TEST_SERVER_URL:-}" ]; then
    log_error "TEST_SERVER_URL environment variable is not set. This script expects the server to be running."
    exit 1
fi

# No specific project needed if env interacts directly with the server API
log_info "========================================="
log_info "Starting 'env' command tests..."
log_info "Using server URL: $TEST_SERVER_URL"
log_info "========================================="

# --- Test Cases ---

# Define test variables
TEST_VAR_KEY="TEST_API_KEY"
TEST_VAR_VALUE="test-value-12345"
TEST_VAR_KEY_2="SECOND_TEST_KEY"
TEST_VAR_VALUE_2="another_value"

# Test 1: Check 'env --help'
log_info "TEST 1: Checking 'env --help'"
run_elizaos env --help
assert_success "'env --help' should execute successfully"
assert_stdout_contains "Usage: elizaos env [options] [command]" "'env --help' output should contain usage info"

# Test 2: Check initial 'env list' (should be empty or default)
log_info "TEST 2: Checking initial 'env list'"
run_elizaos env list
assert_success "'env list' should execute successfully initially"
# Depending on implementation, might show nothing or defaults
# assert_stdout_contains "No environment variables set" "Initial 'env list' should be empty or show defaults"

# TODO: Add tests for different scopes if supported (e.g., --global, --project)

log_info "========================================="
log_info "'env' command tests completed."
log_info "=========================================" 