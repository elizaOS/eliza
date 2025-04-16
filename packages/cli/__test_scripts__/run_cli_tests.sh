#!/usr/bin/env bash

# Main runner script for Eliza CLI shell tests

# Exit on error, treat unset variables as errors, and propagate pipeline failures
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
# shellcheck disable=SC1091 # Path is relative to the script location
source "$SCRIPT_DIR/setup_test_env.sh" # Source setup for logging and executable path

# --- Configuration ---
SERVER_PORT=${TEST_SERVER_PORT:-3000} # Use default port 3000 for tests
TEST_SERVER_URL="http://localhost:$SERVER_PORT"
SERVER_STARTUP_TIMEOUT=30 # seconds to wait for server to start
SERVER_PID_FILE="$TEST_TMP_DIR_BASE/eliza_test_server.pid" # Store PID outside individual test runs
SERVER_LOG_FILE="$TEST_TMP_DIR_BASE/eliza_test_server.log"
MINIMAL_PROJECT_DIR="$TEST_TMP_DIR_BASE/minimal-server-project"
# Define a unique data dir for the test server to avoid state pollution
TEST_SERVER_ELIZA_DIR="$TEST_TMP_DIR_BASE/test_server_eliza_data"

# --- Server Management Functions ---

start_test_server() {
    log_info "Starting test server..."
    
    # Ensure cleanup of previous runs if necessary
    stop_test_server # Attempt to stop if already running
    # Ensure the base temp dir and isolated server data dir exist and are empty
    mkdir -p "$TEST_TMP_DIR_BASE"
    rm -rf "$TEST_SERVER_ELIZA_DIR"
    mkdir -p "$TEST_SERVER_ELIZA_DIR"
    log_info "Using isolated server data directory: $TEST_SERVER_ELIZA_DIR"

    log_info "Starting Eliza server directly in background on port $SERVER_PORT..."
    # Define paths relative to packages/cli for the --characters flag
    local ada_char_path_relative="__test_scripts__/test-characters/ada.json"
    local max_char_path_relative="__test_scripts__/test-characters/max.json"
    local shaw_char_path_relative="__test_scripts__/test-characters/shaw.json"
    # Define executable relative to packages/cli
    local executable_relative_path="dist/index.js"
    # Define PGLite data dir path (needs full path)
    local pglite_data_dir_path="$TEST_SERVER_ELIZA_DIR/pglite-data"
    
    # ---> Run from packages/cli directory <-----
    (
        cd "$CLI_PACKAGE_DIR" # Change to packages/cli
        
        mkdir -p "$pglite_data_dir_path" # Ensure the directory exists using the full path
        
        # ---> Prepend Env Vars, use $ELIZAOS_CMD determined by setup script <-----
        PGLITE_DATA_DIR="$pglite_data_dir_path" \
        PORT=$SERVER_PORT \
        ELIZA_DIR="$TEST_SERVER_ELIZA_DIR" \
        NODE_OPTIONS="" \
        nohup $ELIZAOS_CMD start --characters "$ada_char_path_relative,$max_char_path_relative,$shaw_char_path_relative" > "$SERVER_LOG_FILE" 2>&1 &
        
        echo $! > "$SERVER_PID_FILE"
    )
    # Check PID file creation (outside subshell)
    if [ ! -f "$SERVER_PID_FILE" ]; then
        log_error "PID file not created. Server might have failed immediately."
        log_error "Check server log: $SERVER_LOG_FILE"
        exit 1
    fi
    
    local server_pid
    server_pid=$(cat "$SERVER_PID_FILE")
    # Check if process actually started
    if ! kill -0 "$server_pid" > /dev/null 2>&1; then
         log_error "Server process (PID: $server_pid from file) not running. Server might have failed immediately."
         log_error "Check server log: $SERVER_LOG_FILE"
         cat "$SERVER_LOG_FILE" # Dump log content
         exit 1
    fi
    log_info "Server started with PID: $server_pid. Log: $SERVER_LOG_FILE"

    # Wait for server to be ready
    log_info "Waiting for server to become available at $TEST_SERVER_URL (timeout: ${SERVER_STARTUP_TIMEOUT}s)..."
    local start_time elapsed_time
    start_time=$(date +%s)
    
    while true; do
        if curl --silent --fail "$TEST_SERVER_URL/api/status" > /dev/null 2>&1; then
            log_info "Server status is OK!"
            break
        fi

        elapsed_time=$(( $(date +%s) - start_time ))
        if [ "$elapsed_time" -ge "$SERVER_STARTUP_TIMEOUT" ]; then
            log_error "Server did not start within $SERVER_STARTUP_TIMEOUT seconds."
            log_error "Check server log: $SERVER_LOG_FILE"
            stop_test_server # Attempt cleanup
            exit 1
        fi
        sleep 1 # Wait 1 second before retrying
    done

    # ---> ADDED: Wait specifically for /api/agents to be populated <-----
    log_info "Waiting for agent list at $TEST_SERVER_URL/api/agents to be populated..."
    start_time=$(date +%s) # Reset timer
    local agents_ready=0
    while true; do
        # Use curl -f to fail on HTTP errors, -s for silent, capture output
        agents_json=$(curl -sf "$TEST_SERVER_URL/api/agents" || echo "")
        curl_exit_status=$?
        # ---> Check only for Ada, Max, and Shaw (loaded via --characters) <-----
        if [ $curl_exit_status -eq 0 ] && echo "$agents_json" | grep -q '"name":"Ada"' && echo "$agents_json" | grep -q '"name":"Max"' && echo "$agents_json" | grep -q '"name":"Shaw"'; then
            log_info "Agent list is populated with expected agents (Ada, Max, Shaw)!"
            agents_ready=1
            break
        fi
        
        elapsed_time=$(( $(date +%s) - start_time ))
        # Use the same overall timeout for simplicity, or define a separate one
        if [ "$elapsed_time" -ge "$SERVER_STARTUP_TIMEOUT" ]; then
            log_error "Server started but agent list did not populate correctly within $SERVER_STARTUP_TIMEOUT seconds."
            log_error "Last response from /api/agents: ${agents_json:-<empty or failed>}"
            log_error "Check server log: $SERVER_LOG_FILE"
            stop_test_server # Attempt cleanup
            exit 1
        fi
        log_info "Agent list not ready yet, waiting... (check log: $SERVER_LOG_FILE)"
        sleep 2 # Wait longer between agent list checks
    done
    # --- End of added check ---

    # Export URL for test scripts
    export TEST_SERVER_URL
}

stop_test_server() {
    log_info "Stopping test server..."
    if [ -f "$SERVER_PID_FILE" ]; then
        local pid
        pid=$(cat "$SERVER_PID_FILE")
        if kill -0 "$pid" > /dev/null 2>&1; then
            log_info "Sending SIGTERM to server process $pid"
            kill "$pid"
            # Wait a moment for graceful shutdown
            sleep 2
            if kill -0 "$pid" > /dev/null 2>&1; then
                log_warning "Server process $pid did not exit gracefully, sending SIGKILL"
                kill -9 "$pid"
            fi
            log_info "Server stopped."
        else
            log_info "Server process $pid not found or already stopped."
        fi
        rm -f "$SERVER_PID_FILE"
    else
        log_info "Server PID file not found, server likely not running."
    fi

    # Optionally remove the whole base dir if empty, but safer not to assume
    # find "$TEST_TMP_DIR_BASE" -maxdepth 0 -empty -delete &> /dev/null
}

# --- Cleanup Function ---
# Function to clean up all test directories
cleanup_test_directories() {
    log_info "Cleaning up all test project directories..."
    
    # Find all directories in the test tmp base directory that match the expected format
    # (date format + process ID) and clean them up
    if [ -d "$TEST_TMP_DIR_BASE" ]; then
        log_info "Removing all test directories in $TEST_TMP_DIR_BASE"
        
        # Count how many directories were found
        local test_dirs
        test_dirs=$(find "$TEST_TMP_DIR_BASE" -mindepth 1 -maxdepth 1 -type d -name "[0-9]*_[0-9]*" 2>/dev/null || echo "")
        local dir_count
        dir_count=$(echo "$test_dirs" | grep -v '^$' | wc -l)
        
        if [ "$dir_count" -gt 0 ]; then
            log_info "Found $dir_count test directories to clean up"
            # ---> Use echo instead of log_info within xargs subshell <-----
            echo "$test_dirs" | grep -v '^$' | xargs -I{} sh -c 'echo "[Cleanup] Removing {}..."; rm -rf {}'
            log_info "All test directories removed"
        else
            log_info "No test directories found to clean up"
        fi
    else
        log_info "Test base directory $TEST_TMP_DIR_BASE does not exist, nothing to clean up"
    fi
    
    # Also clean up the server data directory if it exists
    if [ -d "$TEST_SERVER_ELIZA_DIR" ]; then
        log_info "Removing server data directory: $TEST_SERVER_ELIZA_DIR"
        rm -rf "$TEST_SERVER_ELIZA_DIR"
    fi
}

# --- Trap for Cleanup ---
# Ensure server is stopped even if script exits unexpectedly
trap 'stop_test_server; cleanup_test_directories' EXIT SIGINT SIGTERM

# --- Test Execution ---

log_info "==========================================================================================="
log_info "                            ELIZA CLI SHELL TEST SUITE"
log_info "==========================================================================================="

# Check dependencies needed by the test setup itself (this calls function from setup script)
check_dependencies

# Start the test server before running any tests
start_test_server

TOTAL_START_TIME=$(date +%s)
TEST_FILES=($(find "$SCRIPT_DIR" -maxdepth 1 -name 'test_*.sh' -print | sort))
TOTAL_TESTS=${#TEST_FILES[@]}
PASSED_TESTS=0
FAILED_TESTS=0
FAILED_SCRIPTS=()
TIMED_OUT_SCRIPTS=()

# Check for timeout command (standard on Linux, needs coreutils on macOS)
TIMEOUT_CMD="timeout"
if ! command -v timeout &> /dev/null; then
    # Check for gtimeout (GNU timeout from coreutils on macOS)
    if command -v gtimeout &> /dev/null; then
        TIMEOUT_CMD="gtimeout"
        log_info "Using gtimeout from coreutils"
    else
        log_error "Timeout command not found. Please install coreutils."
        log_error "On macOS: brew install coreutils"
        log_error "On Linux: apt-get install coreutils (or equivalent)"
        exit 1
    fi
fi

# For debugging purposes, show the timeout command version
if [[ "$TIMEOUT_CMD" == "timeout" ]]; then
    timeout --version | head -n 1 || log_info "timeout command doesn't support --version"
else
    gtimeout --version | head -n 1 || log_info "gtimeout command doesn't support --version" 
fi

# Set timeout duration - using 60 seconds now
TIMEOUT_DURATION=60
log_info "Found ${TOTAL_TESTS} test script(s) to execute with ${TIMEOUT_DURATION}s timeout..."
echo  # Add spacing for readability

for test_script in "${TEST_FILES[@]}"; do
    script_name=$(basename "$test_script")
    script_start_time=$(date +%s)
    
    log_info "==========================================================================================="
    log_info "EXECUTING TEST SCRIPT: $script_name (timeout: ${TIMEOUT_DURATION}s)"
    log_info "==========================================================================================="

    # ---> Print script name BEFORE execution <-----
    echo "---> Now executing: $script_name <---"

    # Execute the test script in a subshell to isolate environment changes and traps
    # The -k option ensures that if the command doesn't terminate within 5 seconds, it will be forcefully killed
    if $TIMEOUT_CMD -k 1s ${TIMEOUT_DURATION}s bash "$test_script"; then
        script_end_time=$(date +%s)
        script_elapsed=$((script_end_time - script_start_time))
        
        log_info "==========================================================================================="
        log_info "RESULT: PASSED ✅ | TIME: ${script_elapsed}s | SCRIPT: $script_name"
        log_info "==========================================================================================="
        ((PASSED_TESTS++))
    else
        script_end_time=$(date +%s)
        script_elapsed=$((script_end_time - script_start_time))
        exit_code=$?
        
        if [ $exit_code -eq 124 ] || [ $exit_code -eq 137 ]; then
            # Exit code 124 indicates a timeout, 137 indicates SIGKILL (kill -9)
            log_error "==========================================================================================="
            log_error "RESULT: TIMED OUT ⏱️  | TIME: ${script_elapsed}s | SCRIPT: $script_name (exit code: $exit_code)"
            log_error "==========================================================================================="
            log_error "Exiting test suite early due to timeout."
            log_error "This likely indicates an issue with a long-running command that didn't terminate properly."
            ((FAILED_TESTS++))
            FAILED_SCRIPTS+=("$script_name")
            TIMED_OUT_SCRIPTS+=("$script_name")
            
            # Exit immediately on timeout
            TOTAL_END_TIME=$(date +%s)
            TOTAL_ELAPSED=$((TOTAL_END_TIME - TOTAL_START_TIME))
            
            log_info "==========================================================================================="
            log_info "                               TEST SUITE SUMMARY"
            log_info "==========================================================================================="
            log_info "Total Scripts Executed: $((PASSED_TESTS + FAILED_TESTS))"
            log_info "Total Time: ${TOTAL_ELAPSED}s"
            log_info "Passed: $PASSED_TESTS ✅"
            log_info "Failed: $FAILED_TESTS ❌"
            log_error "The test suite was terminated early due to a timeout in $script_name"
            log_info "==========================================================================================="
            exit 1
        else
            log_error "==========================================================================================="
            log_error "RESULT: FAILED ❌ | EXIT CODE: $exit_code | TIME: ${script_elapsed}s | SCRIPT: $script_name"
            log_error "==========================================================================================="
            ((FAILED_TESTS++))
            FAILED_SCRIPTS+=("$script_name")
        fi
        # Optionally stop on first failure
        # exit 1
    fi
    echo # Add a newline for better separation
done

# --- Summary ---
TOTAL_END_TIME=$(date +%s)
TOTAL_ELAPSED=$((TOTAL_END_TIME - TOTAL_START_TIME))

# Make sure we clean up all test directories created during this run
cleanup_test_directories

# Explicitly stop the server after all tests and before the final exit
stop_test_server

log_info "==========================================================================================="
log_info "                               TEST SUITE SUMMARY"
log_info "==========================================================================================="
log_info "Total Scripts Executed: $TOTAL_TESTS"
log_info "Total Time: ${TOTAL_ELAPSED}s"
log_info "Passed: $PASSED_TESTS ✅"
log_info "Failed: $FAILED_TESTS ❌"

if [ $FAILED_TESTS -ne 0 ]; then
    log_error "The following test script(s) failed:"
    for failed_script in "${FAILED_SCRIPTS[@]}"; do
        if [[ " ${TIMED_OUT_SCRIPTS[@]:-} " == *" $failed_script "* ]]; then
            log_error "  - $failed_script (TIMED OUT)"
        else
            log_error "  - $failed_script"
        fi
    done
    log_info "==========================================================================================="
    exit 1
else
    log_info "All test scripts passed successfully! 🎉"
    log_info "==========================================================================================="
    exit 0
fi 