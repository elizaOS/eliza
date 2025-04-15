#!/usr/bin/env bash

# Exit on error, treat unset variables as errors, and propagate pipeline failures
set -euo pipefail

# --- Configuration ---
# Directory where test artifacts will be stored
TEST_TMP_DIR_BASE="${TMPDIR:-/tmp}/eliza_cli_tests"
# Path to the elizaos executable (relative to the package root)
# Assuming this script is run from packages/cli or the repo root after building
# We'll try to find the executable relative to this script's location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
# Go all the way to the repo root (assuming shell-tests is in packages/cli/shell-tests)
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." &> /dev/null && pwd)" # Corrects to eliza repo root
CLI_PACKAGE_DIR="$PROJECT_ROOT/packages/cli"
ELIZAOS_EXECUTABLE="$CLI_PACKAGE_DIR/dist/index.js" # Changed from elizaos.js to index.js

# --- Logging ---
log_info() {
  echo -e "\033[0;32m[INFO] $*\033[0m"
}

log_error() {
  echo -e "\033[0;31m[ERROR] $*\033[0m" >&2
}

log_warning() {
  echo -e "\033[0;33m[WARNING] $*\033[0m"
}

test_pass() {
  echo -e "✅ \033[0;32mPASS: $*\033[0m"
}

test_fail() {
  echo -e "❌ \033[0;31mFAIL: $*\033[0m" >&2
  # Optionally exit immediately on failure, or let the calling script decide
  exit 1 # <-- Make the script exit on failure
}

# --- Dependency Checks ---
check_dependencies() {
  log_info "Checking dependencies..."
  local missing=0
  command -v bun >/dev/null 2>&1 || { log_error "Dependency missing: bun"; missing=1; }
  command -v node >/dev/null 2>&1 || { log_error "Dependency missing: node"; missing=1; }
  # Add other checks like git if needed
  # command -v git >/dev/null 2>&1 || { log_error "Dependency missing: git"; missing=1; }

  if [ "$missing" -eq 1 ]; then
    log_error "Please install missing dependencies and try again."
    exit 1
  fi
  log_info "Dependencies found."
}

# --- Environment Setup ---
prepare_test_environment() {
  log_info "Preparing test environment..."

  # 1. Create a unique temporary working directory for the test run
  TEST_RUN_ID=$(date +%Y%m%d_%H%M%S)_$$
  TEST_TMP_DIR="$TEST_TMP_DIR_BASE/$TEST_RUN_ID"
  mkdir -p "$TEST_TMP_DIR"
  log_info "Created temporary directory: $TEST_TMP_DIR"

  # 2. Navigate to the CLI package directory to ensure context
  # cd "$CLI_PACKAGE_DIR" || { log_error "Failed to cd into $CLI_PACKAGE_DIR"; exit 1; }
  # log_info "Changed working directory to: $(pwd)"
  # Keeping CWD in TEST_TMP_DIR might be better for isolation

  # 3. Ensure the CLI is built (optional, could be a prerequisite)
  # log_info "Ensuring CLI is built..."
  # (cd "$CLI_PACKAGE_DIR" && bun run build) || { log_error "CLI build failed"; exit 1; }

  # 4. Verify elizaos executable exists
  if [ ! -f "$ELIZAOS_EXECUTABLE" ]; then
    log_error "ElizaOS executable not found at $ELIZAOS_EXECUTABLE. Ensure the CLI is built (cd packages/cli && bun run build)."
    exit 1
  fi
  log_info "Found elizaos executable: $ELIZAOS_EXECUTABLE"

  # 5. Set up cleanup trap
  # shellcheck disable=SC2064 # We want TEST_TMP_DIR expanded now
  trap "cleanup '$TEST_TMP_DIR'" EXIT

  # 6. Export variables needed by test scripts
  export TEST_TMP_DIR
  export ELIZAOS_EXECUTABLE
  export PROJECT_ROOT
  # Add other exports as needed

  log_info "Test environment ready in: $TEST_TMP_DIR"
  # Change to the temp dir so tests run isolated
  cd "$TEST_TMP_DIR" || exit 1
}

# --- Cleanup ---
cleanup() {
  local dir_to_clean="$1"
  log_info "Cleaning up test environment: $dir_to_clean ..."
  if [ -d "$dir_to_clean" ]; then
    rm -rf "$dir_to_clean"
    log_info "Removed temporary directory: $dir_to_clean"
  else
    log_info "Temporary directory already removed or never created: $dir_to_clean"
  fi
}

# Enhanced cleanup function that can be called at the end of test scripts
# to ensure all project directories are properly cleaned up
cleanup_test_projects() {
  local test_dir="${1:-$TEST_TMP_DIR}"
  
  if [ ! -d "$test_dir" ]; then
    log_info "Directory for cleanup doesn't exist: $test_dir"
    return 0
  fi
  
  log_info "Performing deep cleanup of all project directories in: $test_dir"
  
  # Find and list all project directories created during tests
  local projects=()
  
  # Look for directories with package.json - these are likely projects
  # Use a more sophisticated find command to locate package.json files
  projects=($(find "$test_dir" -type f -name "package.json" -not -path "*/node_modules/*" | xargs -n1 dirname 2>/dev/null || true))
  
  local count="${#projects[@]}"
  if [ "$count" -gt 0 ]; then
    log_info "Found $count project directories to clean up"
    
    # Clean up node_modules first (they're large and can cause removal to be slow)
    for proj in "${projects[@]}"; do
      if [ -d "$proj/node_modules" ]; then
        log_info "Removing node_modules in: $proj"
        rm -rf "$proj/node_modules"
      fi
    done
    
    # Now delete the project directories themselves if they are subdirectories of our test dir
    # but not the test dir itself (we still need it for the main cleanup function)
    for proj in "${projects[@]}"; do
      if [[ "$proj" != "$test_dir" && "$proj" == "$test_dir"* ]]; then
        log_info "Removing project directory: $proj"
        rm -rf "$proj"
      fi
    done
  else
    log_info "No project directories found for cleanup"
  fi
}

# --- Helper Functions ---

# Execute elizaos command, capture output and exit code
# Usage: run_elizaos <elizaos_args...>
# Stores output in ELIZAOS_STDOUT, stderr in ELIZAOS_STDERR, exit code in ELIZAOS_EXIT_CODE
run_elizaos() {
  local args=("$@")
  local effective_args=()

  # Check if it's an agent command and if TEST_SERVER_URL is set
  if [[ ( "${args[0]}" == "agent" || "${args[0]}" == "env" ) && -n "${TEST_SERVER_URL:-}" ]]; then
    # Inject --remote-url before other args, unless already present
    local has_remote_url=0
    for arg in "${args[@]}"; do
        if [[ "$arg" == "--remote-url" ]]; then
            has_remote_url=1
            break
        fi
    done
    if [[ $has_remote_url -eq 0 ]]; then
        effective_args=("${args[0]}" --remote-url "$TEST_SERVER_URL" "${args[@]:1}")
    else
        effective_args=("${args[@]}") # Use original args if --remote-url is already provided
    fi
  else
      effective_args=("${args[@]}")
  fi

  log_info "Running: node $ELIZAOS_EXECUTABLE ${effective_args[*]}"
  
  # Print a more descriptive message for common operations
  case "${effective_args[0]}" in
    create)
      log_info "Creating project '${effective_args[1]}'. This may take a moment..."
      ;;
    install)
      log_info "Installing dependencies. This may take a moment..."
      ;;
    plugin)
      if [ "${effective_args[1]}" = "add" ]; then
        log_info "Adding plugin '${effective_args[2]}'. This may take a moment..."
      elif [ "${effective_args[1]}" = "remove" ]; then
        log_info "Removing plugin '${effective_args[2]}'..."
      fi
      ;;
    dev|start)
      log_info "Starting server (will be automatically terminated after a few seconds)..."
      ;;
  esac

  # Create temporary files for stdout and stderr
  local stdout_file stderr_file exit_code_file
  stdout_file=$(mktemp) || { log_error "Failed to create stdout temp file"; exit 1; }
  stderr_file=$(mktemp) || { log_error "Failed to create stderr temp file"; rm "$stdout_file"; exit 1; }
  exit_code_file=$(mktemp) || { log_error "Failed to create exit code temp file"; rm "$stdout_file" "$stderr_file"; exit 1; }

  # Ensure cleanup even if command fails non-zero
  trap 'rm -f "$stdout_file" "$stderr_file" "$exit_code_file"' RETURN

  # Run the command, redirecting output and capturing exit code
  # Using 'set +e' temporarily to capture non-zero exit codes without script exiting
  set +e
  # Set ELIZA_DIR for the client command execution, pointing to the script's temp dir
  ELIZA_DIR="$TEST_TMP_DIR/.eliza_client_data" node "$ELIZAOS_EXECUTABLE" "${effective_args[@]}" > "$stdout_file" 2> "$stderr_file"
  local exit_status=$?
  echo "$exit_status" > "$exit_code_file"
  set -e # Re-enable exit on error

  # Read outputs and exit code into variables
  if ! ELIZAOS_STDOUT=$(<"$stdout_file"); then
      log_error "Failed to read stdout temp file: $stdout_file"
      ELIZAOS_STDOUT=""
  fi
  if ! ELIZAOS_STDERR=$(<"$stderr_file"); then
      log_error "Failed to read stderr temp file: $stderr_file"
      ELIZAOS_STDERR=""
  fi
  if ! ELIZAOS_EXIT_CODE=$(<"$exit_code_file"); then
      log_error "Failed to read exit code temp file: $exit_code_file"
      ELIZAOS_EXIT_CODE="999" # Assign a default error code if read fails
  fi

  # Always show brief summary of what happened
  if [ "$ELIZAOS_EXIT_CODE" -eq 0 ]; then
    log_info "Command completed successfully (exit code: 0)"
  else
    log_error "Command failed with exit code: $ELIZAOS_EXIT_CODE"
  fi

  # Explicitly remove files here as trap might not cover all exit paths depending on shell version/settings
  rm -f "$stdout_file" "$stderr_file" "$exit_code_file"
  trap - RETURN # Clear the trap

  # Optional: Log output for debugging
  # if [[ -n "$ELIZAOS_STDOUT" ]]; then log_info "Stdout: $ELIZAOS_STDOUT"; fi
  # if [[ -n "$ELIZAOS_STDERR" ]]; then log_info "Stderr: $ELIZAOS_STDERR"; fi
}

# Extract agent ID from stdout (assumes format like "Agent '...' started with ID: <agent_id>")
# Usage: agent_id=$(parse_agent_id_from_stdout "$ELIZAOS_STDOUT")
# Returns empty string if not found
parse_agent_id_from_stdout() {
    local stdout_content="$1"
    local agent_id=""

    # Regex to capture the ID
    if [[ "$stdout_content" =~ Agent[[:space:]]+'.*'[[:space:]]+started[[:space:]]+with[[:space:]]+ID:[[:space:]]+([a-zA-Z0-9_-]+) ]]; then
        agent_id="${BASH_REMATCH[1]}"
    elif [[ "$stdout_content" =~ Started[[:space:]]+agent[[:space:]]+with[[:space:]]+ID:[[:space:]]+([a-zA-Z0-9_-]+) ]]; then
        # Alternative format check just in case
        agent_id="${BASH_REMATCH[1]}"
    elif [[ "$stdout_content" =~ agentId:[[:space:]]+([a-zA-Z0-9_-]+) ]]; then
         # Another potential format
        agent_id="${BASH_REMATCH[1]}"
    else
        log_error "Could not parse agent ID from stdout content:"
        log_error "$stdout_content"
    fi
    
    echo "$agent_id"
}

# Assert command success (exit code 0)
# Usage: assert_success "Description of command"
assert_success() {
  local description="$1"
  if [ "$ELIZAOS_EXIT_CODE" -eq 0 ]; then
    test_pass "$description [expected success]"
  else
    test_fail "$description [expected success, but got exit code $ELIZAOS_EXIT_CODE]"
    log_error "Stderr: $ELIZAOS_STDERR" # Show stderr on failure
    log_error "Stdout: $ELIZAOS_STDOUT"
    return 1 # Indicate failure
  fi
  return 0 # Indicate success
}

# Assert command failure (non-zero exit code)
# Usage: assert_failure "Description of command" [expected_code]
assert_failure() {
  local description="$1"
  local expected_code # Declare variable
  # Default expected_code if $2 is not provided
  if [ -n "${2:-}" ]; then
      expected_code="$2"
  else
      expected_code=""
  fi

  if [ "$ELIZAOS_EXIT_CODE" -ne 0 ]; then
    if [ -n "$expected_code" ] && [ "$ELIZAOS_EXIT_CODE" -ne "$expected_code" ]; then
       test_fail "$description [expected failure with code $expected_code, but got $ELIZAOS_EXIT_CODE]"
       log_error "Stderr: $ELIZAOS_STDERR"
       log_error "Stdout: $ELIZAOS_STDOUT"
       return 1 # Indicate failure
    else
       test_pass "$description [expected failure, got $ELIZAOS_EXIT_CODE]"
    fi
  else
    test_fail "$description [expected failure, but got exit code 0]"
    log_error "Stdout: $ELIZAOS_STDOUT" # Show stdout on unexpected success
    return 1 # Indicate failure
  fi
  return 0 # Indicate success
}

# Check if a file exists
# Usage: assert_file_exists <path> "Description"
assert_file_exists() {
    local file_path="$1"
    local description="$2"
    if [ -f "$file_path" ]; then
        test_pass "File exists: $file_path [$description]"
    else
        test_fail "File does NOT exist: $file_path [$description]"
        return 1
    fi
    return 0
}

# Check if a directory exists
# Usage: assert_dir_exists <path> "Description"
assert_dir_exists() {
    local dir_path="$1"
    local description="$2"
    if [ -d "$dir_path" ]; then
        test_pass "Directory exists: $dir_path [$description]"
    else
        test_fail "Directory does NOT exist: $dir_path [$description]"
        return 1
    fi
    return 0
}

# Check if file content contains a string (using grep)
# Usage: assert_file_contains <file_path> <pattern> "Description"
assert_file_contains() {
    local file_path="$1"
    local pattern="$2"
    local description="$3"
    if grep -q "$pattern" "$file_path"; then
        test_pass "File '$file_path' contains pattern '$pattern' [$description]"
    else
        test_fail "File '$file_path' does NOT contain pattern '$pattern' [$description]"
        log_error "File content: $(cat "$file_path")"
        return 1
    fi
    return 0
}

# Check if command stdout contains a string
# Usage: assert_stdout_contains <pattern> "Description"
assert_stdout_contains() {
  local pattern="$1"
  local description="$2"
  # Use bash string containment check which might be more robust for multi-line/special chars
  if [[ "${ELIZAOS_STDOUT:-}" == *"$pattern"* ]]; then
    test_pass "Stdout contains pattern '$pattern' [$description]"
  else
    test_fail "Stdout does NOT contain pattern '$pattern' [$description]"
    log_error "Stdout was: $ELIZAOS_STDOUT"
    return 1
  fi
  return 0
}

# Check if command stderr contains a string
# Usage: assert_stderr_contains <pattern> "Description"
assert_stderr_contains() {
  local pattern="$1"
  local description="$2"
  if echo "$ELIZAOS_STDERR" | grep -q "$pattern"; then
    test_pass "Stderr contains pattern '$pattern' [$description]"
  else
    test_fail "Stderr does NOT contain pattern '$pattern' [$description]"
    log_error "Stderr was: $ELIZAOS_STDERR"
    return 1
  fi
  return 0
}

# Check if a directory does NOT exist
# Usage: assert_dir_not_exists <path> "Description"
assert_dir_not_exists() {
    local dir_path="$1"
    local description="$2"
    if [ ! -d "$dir_path" ]; then
        test_pass "Directory does NOT exist (as expected): $dir_path [$description]"
    else
        test_fail "Directory unexpectedly exists: $dir_path [$description]"
        return 1
    fi
    return 0
}

# Check if a file does NOT exist
# Usage: assert_file_not_exists <path> "Description"
assert_file_not_exists() {
    local file_path="$1"
    local description="$2"
    if [ ! -f "$file_path" ]; then
        test_pass "File does NOT exist (as expected): $file_path [$description]"
    else
        test_fail "File unexpectedly exists: $file_path [$description]"
        return 1
    fi
    return 0
}

# Check if file content contains specific text (using grep)
# Usage: assert_file_contains <file_path> <expected_text> "Description"
assert_file_contains() {
    local file_path="$1"
    local expected_text="$2"
    local description="$3"
    if [ ! -f "$file_path" ]; then
        test_fail "File not found for content check: $file_path [$description]"
        return 1
    fi
    # Use grep -q for quiet mode (no output), exit status indicates match
    # Use F to treat pattern as fixed string, x for whole line match (optional)
    # Use || true to prevent script exit if grep fails to find the text
    if grep -qF -- "$expected_text" "$file_path"; then
        test_pass "File '$file_path' contains expected text: \"$expected_text\" [$description]"
    else
        test_fail "File '$file_path' does NOT contain expected text: \"$expected_text\" [$description]"
        log_error "File content (first 10 lines):\n$(head -n 10 "$file_path")"
        return 1
    fi
    return 0
}

# Check if file content does NOT contain specific text (using grep)
# Usage: assert_file_not_contains <file_path> <unexpected_text> "Description"
assert_file_not_contains() {
    local file_path="$1"
    local unexpected_text="$2"
    local description="$3"
    if [ ! -f "$file_path" ]; then
        test_fail "File not found for content check: $file_path [$description]"
        return 1
    fi
    if ! grep -qF -- "$unexpected_text" "$file_path"; then
        test_pass "File '$file_path' does NOT contain unexpected text (as expected): \"$unexpected_text\" [$description]"
    else
        test_fail "File '$file_path' unexpectedly contains text: \"$unexpected_text\" [$description]"
        log_error "File content (first 10 lines):\n$(head -n 10 "$file_path")"
        return 1
    fi
    return 0
}

# Assert that stdout does NOT contain specific text
# Usage: assert_stdout_not_contains <unexpected_text> "Description"
assert_stdout_not_contains() {
    local unexpected_text="$1"
    local description="$2"
    if [[ "${ELIZAOS_STDOUT:-}" != *"$unexpected_text"* ]]; then
        test_pass "Stdout does NOT contain unexpected text (as expected): \"$unexpected_text\" [$description]"
    else
        test_fail "Stdout unexpectedly contains text: \"$unexpected_text\" [$description]"
        log_error "Actual stdout:\n$ELIZAOS_STDOUT"
        return 1
    fi
    return 0
}

# Assert that stderr contains specific text
# Usage: assert_stderr_contains <expected_text> "Description"
assert_stderr_contains() {
    local expected_text="$1"
    local description="$2"
    if [[ "${ELIZAOS_STDERR:-}" == *"$expected_text"* ]]; then
        test_pass "Stderr contains expected text: \"$expected_text\" [$description]"
    else
        test_fail "Stderr does NOT contain expected text: \"$expected_text\" [$description]"
        log_error "Actual stderr:\n$ELIZAOS_STDERR"
        # Also show stdout for context
        log_error "Actual stdout:\n$ELIZAOS_STDOUT"
        return 1
    fi
    return 0
}

# --- Main Execution Flow (Invoked by sourcing scripts) ---
# These steps run when the script is sourced by a test file

# check_dependencies
# prepare_test_environment # Let the individual test script call this after defining its own context

# log_info "setup_test_env.sh sourced successfully."
# log_info "Current working directory: $(pwd)"
# log_info "Temporary test directory: $TEST_TMP_DIR" 