#!/usr/bin/env bats

setup_file() {
  # Start the test server (if needed)
  export TEST_SERVER_PORT=3000
  export TEST_SERVER_URL="http://localhost:$TEST_SERVER_PORT"
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-XXXXXX)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"

  # Start server in background
  $ELIZAOS_CMD start -y --port $TEST_SERVER_PORT >"$TEST_TMP_DIR/server.log" 2>&1 &
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

  # Remove Ada, Max, Shaw if present (ignore errors)
  $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" remove -n Ada 2>/dev/null || true
  $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" remove -n Max 2>/dev/null || true
  $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" remove -n Shaw 2>/dev/null || true

  # Register default agents Ada, Max, and Shaw
  $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start --path "$(pwd)/test-characters/ada.json"
  $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start --path "$(pwd)/test-characters/max.json"
  $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start --path "$(pwd)/test-characters/shaw.json"
}

teardown_file() {
  # Stop the server
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$TEST_TMP_DIR" ] && [[ "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]]; then
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
@test "agent list returns default agents" {
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ada"* ]]
  [[ "$output" == *"Max"* ]]
  [[ "$output" == *"Shaw"* ]]
}

# Checks that agent list works with the CLI and remote URL.
@test "agent list works with CLI remote-url" {
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ada"* ]]
  [[ "$output" == *"Max"* ]]
  [[ "$output" == *"Shaw"* ]]
}

# Ensures agent start loads a character from file successfully.
@test "agent start loads character from file" {
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start --path "$(pwd)/test-characters/ada.json"
  if [ "$status" -eq 0 ]; then
    [[ "$output" == *"started successfully"* ]]
  else
    # Accept failure if the error is about already existing or running
    [[ "$output" == *"already exists"* ]] || [[ "$output" == *"already running"* ]]
  fi
}

# Checks that agent stop works after starting an agent.
@test "agent stop works after start" {
  # Ensure Ada is running before stopping
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start -n Ada
  # Ignore status, as agent may already be running
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" stop -n Ada
  [ "$status" -eq 0 ]
  [[ "$output" == *"stopped successfully"* ]] || [[ "$error" == *"stopped successfully"* ]]
}

# Validates full agent lifecycle: start, check, stop, and cleanup.
@test "agent full lifecycle management" {
  # Start agent
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start -n Ada
  [ "$status" -eq 0 ]
  # Stop agent
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" stop -n Ada
  [ "$status" -eq 0 ]
}
