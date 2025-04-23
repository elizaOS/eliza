#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-XXXXXX)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"
}

teardown() {
  if [ -n "$SERVER_PID" ]; then
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
    unset SERVER_PID
  fi
  cd /
  rm -rf "$TEST_TMP_DIR"
}

# Checks that the start help command displays usage information.
@test "start --help shows usage" {
  run $ELIZAOS_CMD start --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos start"* ]]
}


# Validates that starting with a test-character then lists agents shows the character running.
@test "start and list shows test-character running" {
  # Start server with test-character on fixed port
  export TEST_SERVER_PORT=3000
  PGLITE_DATA_DIR="$TEST_TMP_DIR/pglite"  PORT=$TEST_SERVER_PORT $ELIZAOS_CMD start --character "$BATS_TEST_DIRNAME/test-characters/ada.json" >"$TEST_TMP_DIR/server.log" 2>&1 &
  SERVER_PID=$!
  # Wait for server log to show readiness (up to 10s)
  READY=0
  for i in {1..10}; do
    if grep -q "AgentServer is listening on port $TEST_SERVER_PORT" server.log; then
      READY=1; break
    fi
    sleep 1
  done
  [ "$READY" -eq 1 ]

  SERVER_UP=0
  for i in {1..10}; do
    if curl -sf http://localhost:$TEST_SERVER_PORT/api/agents >/dev/null; then
      SERVER_UP=1; break
    fi
    sleep 1
  done
  [ "$SERVER_UP" -eq 1 ]
  # List agents and verify Ada is present
  run $ELIZAOS_CMD agent --remote-url "http://localhost:3000" list

  # Explicitly call teardown for immediate cleanup
  teardown
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ada"* ]]
  # Cleanup server
  kill "$SERVER_PID"
}
