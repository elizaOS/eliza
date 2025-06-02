#!/usr/bin/env bats

# -----------------------------------------------------------------------------
# Start‑command smoke tests that bring up a temporary ElizaOS server on a random
# port, perform a handful of agent‑level checks, and then tear it down.  Long‑
# running child processes are handled carefully to avoid orphaning.
# -----------------------------------------------------------------------------

setup() {
  set -euo pipefail
  # ---- Ensure port is free.
  if command -v lsof >/dev/null; then
    pids="$(lsof -t -i :3000 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      kill -9 $pids 2>/dev/null || true
      sleep 1
    fi
  fi
  # -----
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-start-XXXXXX)"
  export TEST_SERVER_PORT=3000
  cd "$TEST_TMP_DIR"

  # Use the dist build that sits next to the tests unless caller overrides.
  # Source common utilities
  source "$BATS_TEST_DIRNAME/common.sh"
  setup_elizaos_cmd

  # Make PORT + model envs explicit.
  export LOCAL_SMALL_MODEL="DeepHermes-3-Llama-3-3B-Preview-q4.gguf"
  export LOCAL_MEDIUM_MODEL="$LOCAL_SMALL_MODEL"

  # Launch server in background with the Ada character.
  LOG_LEVEL=debug SQLITE_DATA_DIR="$TEST_TMP_DIR/elizadb" \
  SERVER_PORT="$TEST_SERVER_PORT" \
  $ELIZAOS_CMD start --character "$BATS_TEST_DIRNAME/test-characters/ada.json" \
    >"$TEST_TMP_DIR/server.log" 2>&1 &
  SERVER_PID=$!

  # Wait until log line appears or 15s timeout.
  for _ in $(seq 1 15); do
    grep -q "AgentServer is listening on port $TEST_SERVER_PORT" "$TEST_TMP_DIR/server.log" && break
    sleep 1
  done
  grep -q "AgentServer is listening on port $TEST_SERVER_PORT" "$TEST_TMP_DIR/server.log"

  # API health probe.
  for _ in $(seq 1 10); do
    curl -sf "http://localhost:$TEST_SERVER_PORT/api/agents" >/dev/null && break
    sleep 1
  done
  curl -sf "http://localhost:$TEST_SERVER_PORT/api/agents" >/dev/null
}

teardown() {
  [[ -n "${SERVER_PID:-}" ]] && {
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  }
  [[ -n "${TEST_TMP_DIR:-}" && "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]] && rm -rf "$TEST_TMP_DIR"
}

# -----------------------------------------------------------------------------
# Basic agent check
# -----------------------------------------------------------------------------
@test "start and list shows Ada agent running" {
  run $ELIZAOS_CMD agent list --remote-url "http://localhost:$TEST_SERVER_PORT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ada"* ]]
}

# -----------------------------------------------------------------------------
# Call single agent endpoint (204/200 ok is fine)
# -----------------------------------------------------------------------------
@test "agent endpoint responds" {
  run $ELIZAOS_CMD agent list --remote-url "http://localhost:$TEST_SERVER_PORT"
  [ "$status" -eq 0 ]
  agent_id=$(grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' <<<"$output" | head -1)
  [ -n "$agent_id" ]
  run curl -s -o /dev/null -w "%{http_code}" "http://localhost:$TEST_SERVER_PORT/api/agents/$agent_id"
  [ "$status" -eq 0 ]
  [ "$output" -eq 200 ]
}

# -----------------------------------------------------------------------------
# Custom port flag (-p)
# -----------------------------------------------------------------------------
@test "custom port spin‑up works" {
  NEW_PORT=3456
  LOG_LEVEL=debug SQLITE_DATA_DIR="$TEST_TMP_DIR/elizadb2" \
  $ELIZAOS_CMD start -p "$NEW_PORT" --character "$BATS_TEST_DIRNAME/test-characters/ada.json" \
    >"$TEST_TMP_DIR/port.log" 2>&1 &
  pid=$!
  sleep 4
  run grep -q "AgentServer is listening on port $NEW_PORT" "$TEST_TMP_DIR/port.log"
  kill "$pid" 2>/dev/null || true
  [ "$status" -eq 0 ]
}

# -----------------------------------------------------------------------------
# Multiple character input formats
# -----------------------------------------------------------------------------
@test "multiple character formats parse" {
  for fmt in "," " "; do
    run $ELIZAOS_CMD start --character "$BATS_TEST_DIRNAME/test-characters/ada.json${fmt}$BATS_TEST_DIRNAME/test-characters/ada.json" --help
    [ "$status" -eq 0 ]
  done
}

# -----------------------------------------------------------------------------
# Mixed valid/invalid files should not crash CLI when running with --help (dry)
# -----------------------------------------------------------------------------
@test "graceful acceptance of invalid character file list (dry)" {
  run $ELIZAOS_CMD start --character "$BATS_TEST_DIRNAME/test-characters/ada.json,does-not-exist.json" --help
  [ "$status" -eq 0 ]
}

# -----------------------------------------------------------------------------
# --build flag accepted
# -----------------------------------------------------------------------------
@test "build option flag accepted" {
  run $ELIZAOS_CMD start --build --help
  [ "$status" -eq 0 ]
}

# -----------------------------------------------------------------------------
# --configure flag triggers reconfiguration message in log
# -----------------------------------------------------------------------------
@test "configure option runs" {
  LOG_LEVEL=debug SQLITE_DATA_DIR="$TEST_TMP_DIR/elizadb3" \
  $ELIZAOS_CMD start --configure --character "$BATS_TEST_DIRNAME/test-characters/ada.json" \
    >"$TEST_TMP_DIR/config.log" 2>&1 &
  pid=$!
  sleep 4
  run grep -q "Reconfiguration requested" "$TEST_TMP_DIR/config.log"
  kill "$pid" 2>/dev/null || true
  [ "$status" -eq 0 ]
}

# -----------------------------------------------------------------------------
# send message to Ada agent and get a response
# -----------------------------------------------------------------------------
@test "send message to Ada agent and get a response" {
  local model_dir="$HOME/.eliza/models"
  local model1_name="DeepHermes-3-Llama-3-3B-Preview-q4.gguf"
  local model2_name="bge-small-en-v1.5.Q4_K_M.gguf"
  local model1_path="$model_dir/$model1_name"
  local model2_path="$model_dir/$model2_name"

  # Skip if models are missing AND OpenAI API key is not available
  if ( ! [ -f "$model1_path" ] || ! [ -f "$model2_path" ] ); then
    skip "Skipping test: Required models ('$model1_name', '$model2_name') not found in '$model_dir'"
    # The 'skip' command exits with status 0, marking the test as skipped.
  fi

  # Tests if able to get response from Ada agent
  run $ELIZAOS_CMD agent list --remote-url "http://localhost:$TEST_SERVER_PORT"
  ELIZA_AGENT_ID=$(echo "$output" | grep 'Ada' | sed -E 's/.*│ *([0-9a-f\-]{36}) *.*/\1/')
  local payload="{\"entityId\":\"31c75add-3a49-4bb1-ad40-92c6b4c39558\",\"roomId\":\"$ELIZA_AGENT_ID\",\"source\":\"client_chat\",\"text\":\"Ada, What's your stance on AI regulation?\",\"channelType\":\"API\"}"
  run curl -s -X POST -H "Content-Type: application/json" -d "$payload" "http://localhost:$TEST_SERVER_PORT/api/agents/$ELIZA_AGENT_ID/message"
  [ "$status" -eq 0 ]
  [[ "$output" == *thought* ]]
  [[ "$output" == *action* ]]
}