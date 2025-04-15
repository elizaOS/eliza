#!/usr/bin/env bash

# Test suite for the 'elizaos install' command

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

# cd into the unique test temporary directory
cd "$TEST_TMP_DIR" || exit 1
log_info "Working directory for install tests: $TEST_TMP_DIR"

# Create a project to work within, skipping initial install
TEST_PROJECT_NAME="install-test-project"
log_info "Creating temporary project '$TEST_PROJECT_NAME' for install tests..."
run_elizaos create "$TEST_PROJECT_NAME" --yes
assert_success "Creating '$TEST_PROJECT_NAME' (with install) should succeed"

# Change directory into the created project
cd "$TEST_PROJECT_NAME" || exit 1
log_info "Changed working directory to: $(pwd)"

# Verify node_modules DOES exist initially
assert_dir_exists "node_modules" "node_modules should exist after default create"

# --- Test Cases ---

log_info "========================================="
log_info "Starting 'install' command tests (checking help only)..."
log_info "========================================="

# Test 1: Check 'install --help' (Expected to show main help, not specific install help)
log_info "TEST 1: Checking 'install --help'"
run_elizaos install --help
assert_success "'install --help' should execute successfully (shows main help)"
# assert_stdout_contains "Usage: elizaos install \[options\]" "'install --help' output should contain usage info"

# Note: 'install' is not a dedicated command. Installation happens during 'create' or potentially 'update'.
# The tests for idempotency are implicitly covered by re-running create/update.

log_info "========================================="
log_info "'install' command tests completed."
log_info "=========================================" 