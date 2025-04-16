#!/usr/bin/env bats

setup_file() {
  # Start the test server (if needed)
  export TEST_SERVER_PORT=2412
  export TEST_SERVER_URL="http://localhost:$TEST_SERVER_PORT"
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-XXXXXX)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"

  # Start server in background
  $ELIZAOS_CMD start --port $TEST_SERVER_PORT >"$TEST_TMP_DIR/server.log" 2>&1 &
  SERVER_PID=$!
  # Wait for server to be up (simple sleep or poll)
  sleep 3
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
  sleep ${ELIZAOS_TEST_SLEEP:=1}
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos agent"* ]]
}

# Verifies that agent list returns the default agents when no agents are running.
@test "agent list returns default agents" {
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" list
  sleep ${ELIZAOS_TEST_SLEEP:=1}
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ada"* ]]
  [[ "$output" == *"Max"* ]]
  [[ "$output" == *"Shaw"* ]]
}

# Checks that agent list works with the CLI and remote URL.
@test "agent list works with CLI remote-url" {
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" list
  sleep ${ELIZAOS_TEST_SLEEP:=1}
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ada"* ]]
  [[ "$output" == *"Max"* ]]
  [[ "$output" == *"Shaw"* ]]
}

# Ensures agent start loads a character from file successfully.
@test "agent start loads character from file" {
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start --path /Users/studio/Documents/GitHub/eliza/packages/cli/__test_scripts__/test-characters/ada.json
  sleep ${ELIZAOS_TEST_SLEEP:=1}
  [ "$status" -eq 0 ]
  [[ "$output" == *"started successfully"* ]]
}

# Checks that agent stop works after starting an agent.
@test "agent stop works after start" {
  # Ensure Ada is running before stopping
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start -n Ada
  sleep ${ELIZAOS_TEST_SLEEP:=1}
  # Ignore status, as agent may already be running
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" stop -n Ada
  sleep ${ELIZAOS_TEST_SLEEP:=1}
  [ "$status" -eq 0 ]
  [[ "$output" == *"stopped successfully"* ]] || [[ "$error" == *"stopped successfully"* ]]
}

# Validates full agent lifecycle: start, check, stop, and cleanup.
@test "agent full lifecycle management" {
  # Start agent
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" start -n Ada
  sleep ${ELIZAOS_TEST_SLEEP:=1}
  [ "$status" -eq 0 ]
  # Stop agent
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" stop -n Ada
  sleep ${ELIZAOS_TEST_SLEEP:=1}
  [ "$status" -eq 0 ]
}