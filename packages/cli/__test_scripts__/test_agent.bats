#!/usr/bin/env bats

setup_file() {
  # Start the test server (if needed)
  export TEST_SERVER_PORT=3000
  export TEST_SERVER_URL="http://localhost:$TEST_SERVER_PORT"
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-agent-XXXXXX)"
  # Ensure pglite data dir is unique for this test run
  mkdir -p "$TEST_TMP_DIR/pglite"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"

  # Start server in background with PGLite forced
  LOG_LEVEL=debug PGLITE_DATA_DIR="$TEST_TMP_DIR/pglite" $ELIZAOS_CMD start --port $TEST_SERVER_PORT >"$TEST_TMP_DIR/server.log" 2>&1 &
  SERVER_PID=$! 
  # Wait for server to be up (poll with timeout)
  SERVER_UP=0
  for i in {1..15}; do
    if curl -sf "http://localhost:$TEST_SERVER_PORT/api/agents" >/dev/null; then
      SERVER_UP=1
      break
    fi
    sleep 1
  done
  if [ "$SERVER_UP" -ne 1 ]; then
    echo "[ERROR] ElizaOS server did not start within timeout!"
    echo "--- SERVER LOG ---"
    cat "$TEST_TMP_DIR/server.log"
    echo "------------------"
    exit 1
  fi

  # Start the agents using the existing character files
  $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start --path "$(pwd)/test-characters/ada.json" || true
  $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start --path "$(pwd)/test-characters/max.json" || true
  $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start --path "$(pwd)/test-characters/shaw.json" || true
  
  # Allow a moment for agents to start
  sleep 1
}

teardown_file() {
  # Stop the server
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$TEST_TMP_DIR" ]; then
    rm -rf "$TEST_TMP_DIR"
  fi
}

# Checks that the agent help command displays usage information.
@test "agent help displays usage information" {
  run $ELIZAOS_CMD agent --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos agent"* ]]
}

# Verifies that agent list returns the default agents when no agents are running.
@test "agent list returns agents" {
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ada"* ]] || [[ "$output" == *"Max"* ]] || [[ "$output" == *"Shaw"* ]]
}

# Checks that agent list works with the CLI and remote URL.
@test "agent list works with CLI remote-url" {
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ada"* ]] || [[ "$output" == *"Max"* ]] || [[ "$output" == *"Shaw"* ]]
}

# Test agent list with JSON flag
@test "agent list works with JSON flag" {
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" list --json
  [ "$status" -eq 0 ]
  [[ "$output" == *"["* ]]
  [[ "$output" == *"{"* ]]
  [[ "$output" == *"Name"* ]] || [[ "$output" == *"name"* ]]
  [[ "$output" == *"ID"* ]] || [[ "$output" == *"id"* ]]
}

# Test agent get with name parameter
@test "agent get shows details with name parameter" {
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" get -n Ada
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ada"* ]]
}

# Test agent get with JSON flag
@test "agent get with JSON flag shows character definition" {
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" get -n Ada --json
  [ "$status" -eq 0 ]
  [[ "$output" == *"name"* ]] || [[ "$output" == *"Name"* ]]
  [[ "$output" == *"Ada"* ]]
}

# Test agent get with output flag
@test "agent get with output flag saves to file" {
  OUTPUT_FILE="$TEST_TMP_DIR/output_test.json"
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" get -n Ada --output "$OUTPUT_FILE"
  
  if [ "$status" -eq 0 ]; then
    # Check if file was created
    if [ -f "$OUTPUT_FILE" ]; then
      echo "Output file was successfully created"
      [[ "$(cat "$OUTPUT_FILE")" == *"Ada"* ]]
    else
      echo "Command succeeded but output file was not created"
      false
    fi
  else
    echo "Command failed with status $status"
    echo "Output: $output"
    false
  fi
}

# Ensures agent start loads a character from file successfully.
@test "agent start loads character from file" {
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start --path "$(pwd)/test-characters/ada.json"
  
  # Allow success or "already exists" message
  if [ "$status" -eq 0 ]; then
    [[ "$output" == *"started successfully"* ]] || [[ "$output" == *"created"* ]]
  else
    [[ "$output" == *"already exists"* ]] || [[ "$output" == *"already running"* ]]
  fi
}

# Test agent start with name parameter
@test "agent start works with name parameter" {
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start -n Ada
  
  # Allow either success or already running message
  [ "$status" -eq 0 ] || [[ "$output" == *"already"* ]] 
}

# Test agent start error handling with non-existent character
@test "agent start handles non-existent agent gracefully" {
  # Use a clearly non-existent agent name with special characters to ensure it doesn't exist
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start -n "NonExistentAgent_$$"
  
  # This should either fail with an error message, or it should create the agent
  if [ "$status" -eq 0 ]; then
    # If it succeeded, it means it handled the case by creating a new agent
    [[ "$output" == *"created"* ]] || [[ "$output" == *"started"* ]]
    
    # Clean up by removing the newly created agent
    $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" remove -n "NonExistentAgent_$$" > /dev/null 2>&1 || true
  else
    # If it failed, it should have an appropriate error message
    [[ "$output" == *"not found"* ]] || [[ "$output" == *"error"* ]] || [[ "$output" == *"No agent found"* ]]
  fi
}

# Checks that agent stop works after starting an agent.
@test "agent stop works after start" {
  # Ensure Ada is running before stopping
  $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start -n Ada || true
  
  # Then try to stop it
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" stop -n Ada
  
  # Either success or already stopped
  if [ "$status" -eq 0 ]; then
    [[ "$output" == *"stopped"* ]] || [[ "$output" == *"Stopped"* ]]
  else
    [[ "$output" == *"not running"* ]] || [[ "$output" == *"not found"* ]]
  fi
}

# Test agent set command to update configuration
@test "agent set updates configuration correctly" {
  # Create a config file to update the Ada agent
  cat > "$TEST_TMP_DIR/update_config.json" << EOF
{
  "system": "Updated system prompt for testing"
}
EOF

  # Update Ada's configuration
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" set -n Ada -f "$TEST_TMP_DIR/update_config.json"
  
  # Check either for success or error
  if [ "$status" -eq 0 ]; then
    [[ "$output" == *"updated"* ]] || [[ "$output" == *"Updated"* ]]
  else
    echo "Config update failed with status $status"
    echo "Output: $output"
    false
  fi
}

# Validates full agent lifecycle: start, check, stop, and cleanup.
@test "agent full lifecycle management" {
  # Start agent
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start -n Ada
  # Allow either success or "already running"
  [ "$status" -eq 0 ] || [[ "$output" == *"already"* ]]
  
  # Stop agent
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" stop -n Ada
  # Allow either success or "not running"
  [ "$status" -eq 0 ] || [[ "$output" == *"not running"* ]]
}
