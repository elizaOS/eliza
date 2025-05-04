#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-start-XXXXXX)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"
}

teardown() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    unset SERVER_PID
  fi
  cd /
  if [ -n "$TEST_TMP_DIR" ] && [[ "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]]; then
    rm -rf "$TEST_TMP_DIR"
  fi
}

@test "start and list shows test-character running" {
  export TEST_SERVER_PORT=3000
  LOG_LEVEL=debug PGLITE_DATA_DIR="$TEST_TMP_DIR/pglite" PORT=$TEST_SERVER_PORT $ELIZAOS_CMD start --character "$BATS_TEST_DIRNAME/test-characters/ada.json" >"$TEST_TMP_DIR/server.log" 2>&1 &
  SERVER_PID=$!

  # Ensure SERVER_PID is valid
  if [ -z "$SERVER_PID" ]; then
    echo "Server failed to start. SERVER_PID is empty."
    exit 1
  fi

  # Wait for server readiness (up to 10 seconds)
  READY=0
  for i in {1..10}; do
    if grep -q "AgentServer is listening on port $TEST_SERVER_PORT" "$TEST_TMP_DIR/server.log"; then
      READY=1
      break
    fi
    sleep 1
  done
  [ "$READY" -eq 1 ] || { echo "Server did not become ready."; exit 1; }

  SERVER_UP=0
  for i in {1..10}; do
    if curl -sf http://localhost:$TEST_SERVER_PORT/api/agents >/dev/null; then
      SERVER_UP=1
      break
    fi
    sleep 1
  done
  [ "$SERVER_UP" -eq 1 ] || { echo "Server is not responding."; exit 1; }

  run $ELIZAOS_CMD agent --remote-url "http://localhost:3000" list

  [ "$status" -eq 0 ]
  [[ "$output" == *"Ada"* ]]

  # Explicitly call teardown for immediate cleanup
  teardown
}