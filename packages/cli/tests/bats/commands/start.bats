#!/usr/bin/env bats

load '../helpers/test-helpers'

# Track background processes for cleanup
BACKGROUND_PIDS=()

setup() {
  setup_test_environment
}

teardown() {
  # Kill any background processes
  for pids in "${BACKGROUND_PIDS[@]}"; do
    if [[ -n "$pids" ]]; then
      if [[ "$pids" == *:* ]]; then
        # Handle timeout format (server_pid:timer_pid)
        kill_timeout_processes "$pids"
      else
        # Handle single PID
        kill_process_gracefully "$pids"
      fi
    fi
  done
  
  teardown_test_environment
}

@test "start: shows help with --help flag" {
  run run_cli "dist" start --help
  assert_cli_success
  assert_output --partial "Start the Eliza agent server"
  assert_output --partial "--character"
  assert_output --partial "--port"
}

@test "start: runs with valid character file" {
  create_test_character "test-char.json"
  
  # Start server with 30 second timeout
  local pids=$(start_cli_background_with_timeout "dist" 30 start --character test-char.json)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)  # Store for cleanup
  
  # Give server time to start
  sleep 5
  
  # Check if process is still running
  assert_process_running $server_pid
  
  # Check if port is listening (default 3000)
  if wait_for_port 3000 5; then
    echo "Server started successfully on port 3000"
  else
    # It might use 3001 if 3000 is busy
    wait_for_port 3001 5
  fi
  
  # Clean up - kill processes before timeout
  kill_timeout_processes "$pids"
}

@test "start: fails with missing character file" {
  run run_cli "dist" start --character missing.json
  assert_cli_failure
  assert_output --partial "Character file not found"
}

@test "start: runs with multiple character files" {
  create_test_character "agent1.json"
  create_test_character "agent2.json"
  
  # Start server with multiple characters and timeout
  local pids=$(start_cli_background_with_timeout "dist" 30 start --character agent1.json agent2.json)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  # Check if process is running
  assert_process_running $server_pid
  
  # Clean up before timeout
  kill_timeout_processes "$pids"
}

@test "start: runs with custom port" {
  create_test_character "agent.json"
  
  # Start server on custom port with timeout
  local pids=$(start_cli_background_with_timeout "dist" 30 start --character agent.json --port 4567)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  # Check if process is running
  assert_process_running $server_pid
  
  # Check if custom port is listening
  wait_for_port 4567 5
  
  # Clean up before timeout
  kill_timeout_processes "$pids"
}

@test "start: loads project agents when no character specified" {
  skip "Project agent loading needs proper implementation"
  
  create_test_project "eliza-project"
  cd eliza-project
  
  # Add agent config to package.json
  cat > package.json <<EOF
{
  "name": "eliza-project",
  "version": "1.0.0",
  "type": "module",
  "eliza": {
    "agents": [
      {
        "character": {
          "name": "ProjectAgent",
          "description": "Agent from project config",
          "modelProvider": "openai"
        }
      }
    ]
  }
}
EOF
  
  local pids=$(start_cli_background_with_timeout "dist" 30 start)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  kill_timeout_processes "$pids"
}

@test "start: validates character JSON schema" {
  # Create invalid character - missing required fields
  cat > bad-char.json <<EOF
{
  "invalid": "json",
  "missing": "required fields"
}
EOF
  
  run run_cli "dist" start --character bad-char.json
  assert_cli_failure
  # The error message varies, but it should indicate the character is invalid
  [[ "$output" =~ "validation" ]] || [[ "$output" =~ "Invalid" ]] || [[ "$output" =~ "required" ]]
}

@test "start: handles character with absolute path" {
  create_test_character "test-char.json"
  local abs_path="$(pwd)/test-char.json"
  
  local pids=$(start_cli_background_with_timeout "dist" 30 start --character "$abs_path")
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  kill_timeout_processes "$pids"
}

@test "start: works from monorepo root context" {
  create_test_character "$TEST_DIR/mono-char.json"
  
  local pids=$(start_cli_background_with_timeout "monorepo" 30 start --character "$TEST_DIR/mono-char.json")
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  kill_timeout_processes "$pids"
} 