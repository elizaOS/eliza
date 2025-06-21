#!/usr/bin/env bats

load '../helpers/test-helpers'

setup() {
  setup_test_environment
}

teardown() {
  teardown_test_environment
}

@test "context: CLI works from dist directory" {
  cd "$CLI_ROOT"
  run node dist/index.js --version
  assert_cli_success
  assert_output --regexp "[0-9]+\.[0-9]+\.[0-9]+"
}

@test "context: CLI shows help from dist" {
  cd "$CLI_ROOT"
  run node dist/index.js --help
  assert_cli_success
  assert_output --partial "Usage: elizaos"
  assert_output --partial "Commands:"
  assert_output --partial "create"
  assert_output --partial "start"
  assert_output --partial "test"
}

@test "context: CLI works from monorepo root" {
  run run_cli "monorepo" --version
  assert_cli_success
  assert_output --regexp "[0-9]+\.[0-9]+\.[0-9]+"
}

@test "context: CLI commands work from monorepo root" {
  cd "$MONOREPO_ROOT"
  run node packages/cli/dist/index.js create --help
  assert_cli_success
  assert_output --partial "Create a new ElizaOS project"
}

@test "context: Environment variables are respected" {
  export ELIZA_NO_AUTO_INSTALL=true
  export NO_COLOR=1
  export ELIZA_LOG_LEVEL=debug
  
  run run_cli "dist" --version
  assert_cli_success
  
  # Verify no color codes in output
  refute_output --partial $'\033'
}

@test "context: CLI works with relative paths" {
  create_test_character "relative-char.json"
  
  # Test with relative path
  run_cli "dist" start --character ./relative-char.json &
  local pid=$!
  
  sleep 3
  assert_process_running $pid
  
  kill $pid 2>/dev/null || true
  wait_for_process $pid
}

@test "context: CLI works with absolute paths" {
  create_test_character "absolute-char.json"
  local abs_path="$(pwd)/absolute-char.json"
  
  # Change to different directory
  mkdir -p subdir
  cd subdir
  
  # Use absolute path from different directory
  run_cli "dist" start --character "$abs_path" &
  local pid=$!
  
  sleep 3
  assert_process_running $pid
  
  kill $pid 2>/dev/null || true
  wait_for_process $pid
}

@test "context: CLI preserves working directory" {
  create_test_project "context-project"
  cd context-project
  
  # Get initial directory
  local initial_dir="$(pwd)"
  
  # Run command
  run run_cli "dist" --version
  assert_cli_success
  
  # Verify we're still in same directory
  [[ "$(pwd)" == "$initial_dir" ]]
}

@test "context: CLI handles spaces in paths" {
  mkdir -p "test directory with spaces"
  cd "test directory with spaces"
  
  create_test_character "space char.json"
  
  run_cli "dist" start --character "space char.json" &
  local pid=$!
  
  sleep 3
  assert_process_running $pid
  
  kill $pid 2>/dev/null || true
  wait_for_process $pid
}

@test "context: CLI handles unicode in paths" {
  skip "Unicode path handling causes permission issues in cleanup"
  
  # TODO: Fix unicode path handling in the database initialization
  # The test creates directories with unicode names that then can't be 
  # deleted properly, causing permission errors
}

@test "context: CLI respects NODE_OPTIONS" {
  export NODE_OPTIONS="--max-old-space-size=512"
  
  run run_cli "dist" --version
  assert_cli_success
}

@test "context: CLI works after npm link" {
  # Check if we have npm
  if ! command -v npm >/dev/null 2>&1; then
    skip "npm not available"
  fi
  
  # Save current directory
  local original_dir="$(pwd)"
  
  cd "$CLI_ROOT"
  
  # Build before linking
  run bun run build
  assert_success
  
  # Create npm link
  run npm link
  assert_success
  
  # Create a test directory outside the monorepo
  local test_link_dir="$BATS_TEST_TMPDIR/npm-link-test"
  mkdir -p "$test_link_dir"
  cd "$test_link_dir"
  
  # Link the CLI
  run npm link @elizaos/cli
  assert_success
  
  # Test the linked CLI
  run elizaos --version
  assert_cli_success
  assert_output --regexp "[0-9]+\.[0-9]+\.[0-9]+"
  
  # Test a command
  run elizaos create --help
  assert_cli_success
  assert_output --partial "Create a new ElizaOS project"
  
  # Cleanup
  cd "$test_link_dir"
  npm unlink @elizaos/cli || true
  cd "$CLI_ROOT"
  npm unlink || true
  cd "$original_dir"
  rm -rf "$test_link_dir"
}

@test "context: CLI works via npx simulation" {
  # Simulate npx by using full path
  local cli_path="$CLI_ROOT/dist/index.js"
  
  cd "$TEST_DIR"
  
  # Use timeout to prevent hanging
  if [[ -n "$TIMEOUT_CMD" ]]; then
    run $TIMEOUT_CMD 5 node "$cli_path" --version
  else
    run node "$cli_path" --version
  fi
  
  assert_cli_success
  assert_output --regexp "[0-9]+\.[0-9]+\.[0-9]+"
} 