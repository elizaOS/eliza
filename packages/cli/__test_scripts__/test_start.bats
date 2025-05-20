#!/usr/bin/env bats

# -----------------------------------------------------------------------------
# Start‑command smoke tests that bring up a temporary ElizaOS server on a random
# port, perform a handful of agent‑level checks, and then tear it down.  Long‑
# running child processes are handled carefully to avoid orphaning.
# -----------------------------------------------------------------------------

setup() {
  set -euo pipefail

  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-start-XXXXXX)"
  export TEST_SERVER_PORT=3000
  cd "$TEST_TMP_DIR"

  # Use the dist build that sits next to the tests unless caller overrides.
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run $(cd "$BATS_TEST_DIRNAME/../dist" && pwd)/index.js}"

  # Make PORT + model envs explicit.
  export LOCAL_SMALL_MODEL="DeepHermes-3-Llama-3-3B-Preview-q4.gguf"
  export LOCAL_MEDIUM_MODEL="$LOCAL_SMALL_MODEL"

  # Launch server in background with the Ada character.
  LOG_LEVEL=debug PGLITE_DATA_DIR="$TEST_TMP_DIR/pglite" \
  PORT="$TEST_SERVER_PORT" \
  $ELIZAOS_CMD start --character "$BATS_TEST_DIRNAME/test-characters/ada.json" \
    >"$TEST_TMP_DIR/server.log" 2>&1 &
  SERVER_PID=$!

  # Wait until log line appears or 15 s timeout.
  for _ in {1..15}; do
    grep -q "AgentServer is listening on port $TEST_SERVER_PORT" "$TEST_TMP_DIR/server.log" && break
    sleep 1
  done
  grep -q "AgentServer is listening on port $TEST_SERVER_PORT" "$TEST_TMP_DIR/server.log"

  # API health probe.
  for _ in {1..10}; do
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
  run $ELIZAOS_CMD agent --remote-url "http://localhost:$TEST_SERVER_PORT" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ada"* ]]
}

# -----------------------------------------------------------------------------
# Call single agent endpoint (204/200 ok is fine)
# -----------------------------------------------------------------------------
@test "agent endpoint responds" {
  run $ELIZAOS_CMD agent --remote-url "http://localhost:$TEST_SERVER_PORT" list
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
  LOG_LEVEL=debug PGLITE_DATA_DIR="$TEST_TMP_DIR/pglite2" \
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
  LOG_LEVEL=debug PGLITE_DATA_DIR="$TEST_TMP_DIR/pglite3" \
  $ELIZAOS_CMD start --configure --character "$BATS_TEST_DIRNAME/test-characters/ada.json" \
    >"$TEST_TMP_DIR/config.log" 2>&1 &
  pid=$!
  sleep 4
  run grep -q "Reconfiguration requested" "$TEST_TMP_DIR/config.log"
  kill "$pid" 2>/dev/null || true
  [ "$status" -eq 0 ]
}