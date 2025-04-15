#!/usr/bin/env bash

# Test suite for the 'elizaos dev' command

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
log_info "Working directory for dev tests: $TEST_TMP_DIR"

# Create a project to run dev mode in
TEST_PROJECT_NAME="dev-test-project"
log_info "Creating temporary project '$TEST_PROJECT_NAME' for dev tests..."
run_elizaos create "$TEST_PROJECT_NAME" --yes
assert_success "Creating '$TEST_PROJECT_NAME' (default) should succeed"

# Dependencies are installed by create, no need for separate install step
cd "$TEST_PROJECT_NAME" || exit 1
# log_info "Installing dependencies for $TEST_PROJECT_NAME..."
# run_elizaos install
# assert_success "Installing dependencies for $TEST_PROJECT_NAME"
log_info "Changed working directory to: $(pwd)"

# --- Test Cases ---

log_info "========================================="
log_info "Starting 'dev' command tests..."
log_info "========================================="

# Test 1: Check 'dev --help'
log_info "TEST 1: Checking 'dev --help'"
run_elizaos dev --help
assert_success "'dev --help' should execute successfully"
assert_stdout_contains "Usage: elizaos dev [options]" "'dev --help' output should contain usage info"

# Test 2: Run 'elizaos dev' in background and check accessibility
DEV_PORT=3002 # Use a different port for the dev server
DEV_URL="http://localhost:$DEV_PORT"
DEV_PID_FILE="$TEST_TMP_DIR/dev_server.pid"
DEV_LOG_FILE="$TEST_TMP_DIR/dev_server.log"
DEV_STARTUP_TIMEOUT=30 # seconds

log_info "TEST 2: Running 'elizaos dev' in background on port $DEV_PORT"

# Start dev server in background
nohup node "$ELIZAOS_EXECUTABLE" dev --port "$DEV_PORT" > "$DEV_LOG_FILE" 2>&1 &
DEV_PID=$!
echo "$DEV_PID" > "$DEV_PID_FILE"

log_info "Dev server process started with PID: $DEV_PID. Log: $DEV_LOG_FILE"

# Ensure the process is terminated on exit
trap 'echo "Cleaning up dev server PID $DEV_PID..."; kill $DEV_PID || true; rm -f "$DEV_PID_FILE"' EXIT SIGINT SIGTERM

# Wait for dev server to become available
log_info "Waiting for dev server to respond at $DEV_URL/api/status (timeout: ${DEV_STARTUP_TIMEOUT}s)..."
start_time=$(date +%s)
elapsed_time=0
server_up=0

while [ "$elapsed_time" -lt "$DEV_STARTUP_TIMEOUT" ]; do
    # Check if the process is still running before curling
    if ! kill -0 "$DEV_PID" > /dev/null 2>&1; then
        log_error "Dev server process (PID: $DEV_PID) exited unexpectedly."
        test_fail "Dev server process terminated prematurely"
        log_error "Check dev server log: $DEV_LOG_FILE"
        cat "$DEV_LOG_FILE" >&2
        exit 1 # Fail the test script
    fi

    # Try to connect
    if curl --silent --fail "$DEV_URL/api/status" > /dev/null 2>&1; then
        log_info "Dev server is up!"
        test_pass "Dev server responded successfully to status check on port $DEV_PORT"
        server_up=1
        break
    fi
    sleep 1
    elapsed_time=$(( $(date +%s) - start_time ))
done

if [ $server_up -eq 0 ]; then
    test_fail "Dev server did not start or respond within $DEV_STARTUP_TIMEOUT seconds on port $DEV_PORT"
    log_error "Check dev server log: $DEV_LOG_FILE"
    cat "$DEV_LOG_FILE" >&2
    # Attempt to kill the process before exiting
    kill "$DEV_PID" || true
    exit 1
fi

# Test 3: Run 'agent list' against the dev server
log_info "TEST 3: Running 'agent list' against dev server $DEV_URL"
set +e # Allow capturing non-zero exit code
# Run agent list directly, targeting the dev server URL and capturing output
AGENT_LIST_STDOUT=$(ELIZA_DIR="$TEST_TMP_DIR/.eliza_client_data_dev" node "$ELIZAOS_EXECUTABLE" agent list --remote-url "$DEV_URL" 2> /dev/null)
AGENT_LIST_EXIT_CODE=$?
set -e # Re-enable exit on error

if [ $AGENT_LIST_EXIT_CODE -eq 0 ]; then
    test_pass "'agent list --remote-url $DEV_URL' succeeded against dev server"
else
    test_fail "'agent list --remote-url $DEV_URL' failed against dev server (exit code: $AGENT_LIST_EXIT_CODE)"
    log_error "Agent list stdout: $AGENT_LIST_STDOUT"
fi

# Check if the output contains the default agent
if [[ "${AGENT_LIST_STDOUT:-}" == *"Eliza"* ]]; then
    test_pass "'agent list' output contains default agent 'Eliza'"
else
    test_fail "'agent list' output does NOT contain default agent 'Eliza'"
    log_error "Agent list stdout: $AGENT_LIST_STDOUT"
fi

# Cleanup: Stop the dev server (trap will also try)
log_info "Stopping dev server (PID: $DEV_PID)..."
kill "$DEV_PID"
sleep 1
if kill -0 "$DEV_PID" > /dev/null 2>&1; then
    log_warning "Dev server $DEV_PID did not stop gracefully, sending SIGKILL"
    kill -9 "$DEV_PID"
fi
rm -f "$DEV_PID_FILE"
trap - EXIT SIGINT SIGTERM # Clear the specific trap for this process
log_info "Dev server stopped."

log_info "========================================="
log_info "'dev' command tests completed."
log_info "=========================================" 