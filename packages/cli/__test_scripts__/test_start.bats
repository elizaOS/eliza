#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-start-XXXXXX)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"
  export TEST_SERVER_PORT=3000
  # Use same 3B model for both small and medium Local AI models
  export LOCAL_SMALL_MODEL="DeepHermes-3-Llama-3-3B-Preview-q4.gguf"
  export LOCAL_MEDIUM_MODEL="DeepHermes-3-Llama-3-3B-Preview-q4.gguf"
  LOG_LEVEL=debug PGLITE_DATA_DIR="$TEST_TMP_DIR/pglite" PORT=$TEST_SERVER_PORT $ELIZAOS_CMD start --character "$BATS_TEST_DIRNAME/test-characters/ada.json" >"$TEST_TMP_DIR/server.log" 2>&1 &
  SERVER_PID=$!
  READY=0
  for i in {1..10}; do
    if grep -q "AgentServer is listening on port $TEST_SERVER_PORT" "$TEST_TMP_DIR/server.log"; then
      READY=1; break
    fi
    sleep 1
  done
  [ "$READY" -eq 1 ] || { echo "Server did not become ready."; exit 1; }
  SERVER_UP=0
  for i in {1..5}; do
    if curl -sf http://localhost:$TEST_SERVER_PORT/api/agents >/dev/null; then
      SERVER_UP=1; break
    fi
    sleep 1
  done
  [ "$SERVER_UP" -eq 1 ] || { echo "Server is not responding."; exit 1; }
  sleep 2
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

@test "start and list shows Ada agent running" {
  run $ELIZAOS_CMD agent --remote-url "http://localhost:$TEST_SERVER_PORT" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ada"* ]]
}

@test "send message to Ada agent and get a response" {
  run $ELIZAOS_CMD agent --remote-url "http://localhost:$TEST_SERVER_PORT" list
  ELIZA_AGENT_ID=$(echo "$output" | grep 'Ada' | sed -E 's/.*│ *([0-9a-f\-]{36}) *.*/\1/')
  local payload="{\"entityId\":\"31c75add-3a49-4bb1-ad40-92c6b4c39558\",\"roomId\":\"$ELIZA_AGENT_ID\",\"source\":\"client_chat\",\"text\":\"Ada, What's your stance on AI regulation?\",\"channelType\":\"API\"}"
  run curl -s -X POST -H "Content-Type: application/json" -d "$payload" "http://localhost:$TEST_SERVER_PORT/api/agents/$ELIZA_AGENT_ID/message"
  [ "$status" -eq 0 ]
  [[ "$output" == *thought* ]]
  [[ "$output" == *action* ]]
}