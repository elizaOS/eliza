#!/usr/bin/env bash

# Test suite for the 'elizaos plugin' command group

# Exit on error, treat unset variables as errors, and propagate pipeline failures
# Disable exit on error for more resilient script execution
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
log_info "Working directory for plugin tests: $TEST_TMP_DIR"

# Create a project to work within
TEST_PROJECT_NAME="plugin-test-project"
log_info "Creating temporary project '$TEST_PROJECT_NAME' for plugin tests..."
run_elizaos create "$TEST_PROJECT_NAME" --yes
assert_success "Creating '$TEST_PROJECT_NAME' should succeed"
# This is a setup step, not a test, so don't increment test counters

# Change directory into the created project
cd "$TEST_PROJECT_NAME" || exit 1
log_info "Changed working directory to: $(pwd)"

# --- Test Cases ---

log_info "========================================="
log_info "Starting 'plugin' command tests..."
log_info "========================================="

# Test 1: Check 'plugin --help'
log_info "TEST 1: Checking 'plugin --help'"
run_elizaos plugin --help
TEST1_SUCCESS=true
if ! assert_success "'plugin --help' should execute successfully"; then
    TEST1_SUCCESS=false
fi
if ! assert_stdout_contains "Usage: elizaos plugin [options] [command]" "'plugin --help' output should contain usage info"; then
    TEST1_SUCCESS=false
fi
if ! assert_stdout_contains "publish" "'plugin --help' should list the 'publish' subcommand"; then
    TEST1_SUCCESS=false
fi
((TESTS_TOTAL++))
if [ "$TEST1_SUCCESS" = true ]; then 
    ((TESTS_PASSED++))
    log_info "✅ TEST 1 PASSED - Running count: $TESTS_PASSED passed, $TESTS_FAILED failed out of $TESTS_TOTAL"
else 
    ((TESTS_FAILED++))
    log_error "❌ TEST 1 FAILED - Running count: $TESTS_PASSED passed, $TESTS_FAILED failed out of $TESTS_TOTAL"
fi

# Test 2: Check 'plugin publish --help'
log_info "TEST 2: Checking 'plugin publish --help'"
# Change to a plugin project context first
cd "$TEST_TMP_DIR" || log_error "Failed to change to TEST_TMP_DIR"
log_info "Changed to directory: $(pwd)"

PLUGIN_PROJECT_NAME="test-plugin-for-publish"
log_info "Creating plugin project '$PLUGIN_PROJECT_NAME'..."
run_elizaos create "$PLUGIN_PROJECT_NAME" --yes --type plugin
assert_success "Creating plugin project '$PLUGIN_PROJECT_NAME' should succeed"
# Project creation is a setup step, not a test

# Debug: Examine the stdout to see what directory was created
log_info "DEBUG: Create command stdout: $ELIZAOS_STDOUT"

# Debug: List directories to see what was actually created
log_info "DEBUG: Listing directories in $TEST_TMP_DIR after plugin creation:"
ls -la "$TEST_TMP_DIR"

# Try to find the plugin directory with or without the prefix
ACTUAL_PLUGIN_DIR=""
if [ -d "$PLUGIN_PROJECT_NAME" ]; then
    ACTUAL_PLUGIN_DIR="$PLUGIN_PROJECT_NAME"
    log_info "DEBUG: Found plugin directory at expected location: $ACTUAL_PLUGIN_DIR"
elif [ -d "plugin-$PLUGIN_PROJECT_NAME" ]; then
    ACTUAL_PLUGIN_DIR="plugin-$PLUGIN_PROJECT_NAME"
    log_info "DEBUG: Found plugin directory with prefix: $ACTUAL_PLUGIN_DIR"
else
    log_error "DEBUG: Could not find plugin directory with or without prefix"
    # List all files to help debug
    find "$TEST_TMP_DIR" -type d -maxdepth 2 | sort
fi

# Use the actual plugin directory if found
if [ -n "$ACTUAL_PLUGIN_DIR" ]; then
    log_info "DEBUG: Changed to plugin directory: $ACTUAL_PLUGIN_DIR"
    cd "$ACTUAL_PLUGIN_DIR" || log_error "Failed to change to $ACTUAL_PLUGIN_DIR"
else
    log_error "Could not find plugin directory, continuing test with current directory"
fi

run_elizaos plugin publish --help
TEST2_SUCCESS=true
if ! assert_success "'plugin publish --help' should execute successfully"; then
    TEST2_SUCCESS=false
fi
if ! assert_stdout_contains "Usage: elizaos plugin publish [options]" "'plugin publish --help' output should contain usage info"; then
    TEST2_SUCCESS=false
fi
((TESTS_TOTAL++))
if [ "$TEST2_SUCCESS" = true ]; then
    ((TESTS_PASSED++))
    log_info "✅ TEST 2 PASSED - Running count: $TESTS_PASSED passed, $TESTS_FAILED failed out of $TESTS_TOTAL"
else
    ((TESTS_FAILED++))
    log_error "❌ TEST 2 FAILED - Running count: $TESTS_PASSED passed, $TESTS_FAILED failed out of $TESTS_TOTAL"
fi

# Test 3: Test adding a plugin using 'project add-plugin' command 
log_info "TEST 3: Adding plugin via 'project add-plugin'"
cd "$TEST_TMP_DIR/$TEST_PROJECT_NAME" || log_error "Failed to change back to test project directory"

# Add PDF plugin
PLUGIN_PDF="@elizaos/plugin-pdf"
log_info "Adding plugin $PLUGIN_PDF..."
run_elizaos project add-plugin "$PLUGIN_PDF" --no-env-prompt
TEST3_SUCCESS=true
if [ "$ELIZAOS_EXIT_CODE" -eq 0 ]; then
    log_info "Successfully added PDF plugin"
    if ! assert_stdout_contains "$PLUGIN_PDF" "Output should mention PDF plugin name" || 
       ! assert_file_contains "package.json" "$PLUGIN_PDF" "package.json should contain $PLUGIN_PDF"; then
        TEST3_SUCCESS=false
    fi
else
    log_warning "Adding PDF plugin failed"
    TEST3_SUCCESS=false
fi
# Count test result
((TESTS_TOTAL++))
if [ "$TEST3_SUCCESS" = true ]; then
    ((TESTS_PASSED++))
    log_info "✅ TEST 3 PASSED - Running count: $TESTS_PASSED passed, $TESTS_FAILED failed out of $TESTS_TOTAL"
else
    ((TESTS_FAILED++))
    log_error "❌ TEST 3 FAILED - Running count: $TESTS_PASSED passed, $TESTS_FAILED failed out of $TESTS_TOTAL"
fi

# Test 4: Test adding multiple plugins using 'project add-plugin'
log_info "TEST 4: Adding multiple plugins (anthropic, twitter, sql) via 'project add-plugin'"
cd "$TEST_TMP_DIR/$TEST_PROJECT_NAME" || log_error "Failed to change back to test project directory"

# Initialize test result for multiple plugin test
MULTI_PLUGIN_TEST_PASSED=true

# Add anthropic plugin
PLUGIN_ANTHROPIC="@elizaos/plugin-anthropic"
log_info "Adding plugin $PLUGIN_ANTHROPIC..."
run_elizaos project add-plugin "$PLUGIN_ANTHROPIC" --no-env-prompt
if [ "$ELIZAOS_EXIT_CODE" -eq 0 ]; then
    log_info "Successfully added anthropic plugin"
    if ! assert_stdout_contains "$PLUGIN_ANTHROPIC" "Output should mention anthropic plugin name" || 
       ! assert_file_contains "package.json" "$PLUGIN_ANTHROPIC" "package.json should contain $PLUGIN_ANTHROPIC"; then
        MULTI_PLUGIN_TEST_PASSED=false
        log_error "❌ Anthropic plugin validation failed"
    fi
else
    log_warning "Adding anthropic plugin failed"
    MULTI_PLUGIN_TEST_PASSED=false
    log_error "❌ Anthropic plugin installation failed"
fi

# Add twitter plugin
PLUGIN_TWITTER="@elizaos/plugin-twitter"
log_info "Adding plugin $PLUGIN_TWITTER..."
run_elizaos project add-plugin "$PLUGIN_TWITTER" --no-env-prompt
if [ "$ELIZAOS_EXIT_CODE" -eq 0 ]; then
    log_info "Successfully added twitter plugin"
    if ! assert_stdout_contains "$PLUGIN_TWITTER" "Output should mention twitter plugin name" || 
       ! assert_file_contains "package.json" "$PLUGIN_TWITTER" "package.json should contain $PLUGIN_TWITTER"; then
        MULTI_PLUGIN_TEST_PASSED=false
        log_error "❌ Twitter plugin validation failed"
    fi
else
    log_warning "Adding twitter plugin failed"
    MULTI_PLUGIN_TEST_PASSED=false
    log_error "❌ Twitter plugin installation failed"
fi

# Add sql plugin
PLUGIN_SQL="@elizaos/plugin-sql"
log_info "Adding plugin $PLUGIN_SQL..."
run_elizaos project add-plugin "$PLUGIN_SQL" --no-env-prompt
if [ "$ELIZAOS_EXIT_CODE" -eq 0 ]; then
    log_info "Successfully added sql plugin"
    if ! assert_stdout_contains "$PLUGIN_SQL" "Output should mention sql plugin name" || 
       ! assert_file_contains "package.json" "$PLUGIN_SQL" "package.json should contain $PLUGIN_SQL"; then
        MULTI_PLUGIN_TEST_PASSED=false
        log_error "❌ SQL plugin validation failed"
    fi
else
    log_warning "Adding sql plugin failed"
    MULTI_PLUGIN_TEST_PASSED=false
    log_error "❌ SQL plugin installation failed"
fi

# Verify all plugins were added
log_info "Verifying all plugins were added to the project..."
run_elizaos project installed-plugins
if ! assert_success "'project installed-plugins' should succeed" || 
   ! assert_stdout_contains "$PLUGIN_ANTHROPIC" "installed-plugins should show Anthropic plugin" ||
   ! assert_stdout_contains "$PLUGIN_TWITTER" "installed-plugins should show Twitter plugin" ||
   ! assert_stdout_contains "$PLUGIN_SQL" "installed-plugins should show SQL plugin"; then
    MULTI_PLUGIN_TEST_PASSED=false
    log_error "❌ Verification of installed plugins failed"
fi

# Count as one test with success or failure
((TESTS_TOTAL++))
if [ "$MULTI_PLUGIN_TEST_PASSED" = true ]; then
    ((TESTS_PASSED++))
    log_info "✅ TEST 4 PASSED - Running count: $TESTS_PASSED passed, $TESTS_FAILED failed out of $TESTS_TOTAL"
else
    ((TESTS_FAILED++))
    log_error "❌ TEST 4 FAILED - Running count: $TESTS_PASSED passed, $TESTS_FAILED failed out of $TESTS_TOTAL"
fi

log_info "========================================="
log_info "'plugin' command tests completed."
log_info "========================================="
log_info "Tests: $TESTS_TOTAL | Passed: $TESTS_PASSED | Failed: $TESTS_FAILED" 

# Return appropriate exit code for CI/CD
if [ $TESTS_FAILED -gt 0 ]; then
  log_error "❌ $TESTS_FAILED tests failed"
  exit 1
else
  log_info "✅ All tests passed successfully"
  exit 0
fi 