#!/usr/bin/env bats

# -----------------------------------------------------------------------------
# End‑to‑end tests for the ElizaOS agent sub‑commands running against a local
# ElizaOS server instance backed by PGLite. The server is started once per test
# file (setup_file) and torn down in teardown_file.
# -----------------------------------------------------------------------------

setup_file() {
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

  # ---------------------------------------------------------------------------
  # Dynamic paths / ports so parallel test runners don't collide.
  # ---------------------------------------------------------------------------
  export TEST_SERVER_PORT=3000
  export TEST_SERVER_URL="http://localhost:$TEST_SERVER_PORT"
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-agent-XXXXXX)"
  mkdir -p "$TEST_TMP_DIR/elizadb"

  # Resolve CLI path; allow caller to override ELIZAOS_CMD.
  # Source common utilities
  source "$BATS_TEST_DIRNAME/common.sh"
  setup_elizaos_cmd

  # ---------------------------------------------------------------------------
  # Launch the server under test.
  # ---------------------------------------------------------------------------
  echo "[DEBUG] Starting ElizaOS server on port $TEST_SERVER_PORT" >&2
  echo "[DEBUG] Server command: $ELIZAOS_CMD start --port $TEST_SERVER_PORT" >&2
  echo "[DEBUG] PGLite data dir: $TEST_TMP_DIR/elizadb" >&2
  echo "[DEBUG] Server log file: $TEST_TMP_DIR/server.log" >&2
  
  LOG_LEVEL=debug \
  PGLITE_DATA_DIR="$TEST_TMP_DIR/elizadb" \
  $ELIZAOS_CMD start --port "$TEST_SERVER_PORT" \
    >"$TEST_TMP_DIR/server.log" 2>&1 &
  SERVER_PID=$!
  echo "[DEBUG] Server PID: $SERVER_PID" >&2

  # Poll until the REST endpoint comes up (max 30 s with more verbose logging).
  echo "[DEBUG] Polling for server readiness at $TEST_SERVER_URL/api/agents" >&2
  for i in $(seq 1 30); do
    echo "[DEBUG] Attempt $i/30: checking server health..." >&2
    if curl -sf "$TEST_SERVER_URL/api/agents" >/dev/null 2>&1; then
      echo "[DEBUG] Server is ready!" >&2
      break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "[ERROR] Server process died during startup" >&2
      echo "--- SERVER LOG ---" >&2
      cat "$TEST_TMP_DIR/server.log" >&2
      echo "------------------" >&2
      exit 1
    fi
    echo "[DEBUG] Server not ready yet, waiting 1s..." >&2
    sleep 1
  done
  
  if ! kill -0 "$SERVER_PID" 2>/dev/null || ! curl -sf "$TEST_SERVER_URL/api/agents" >/dev/null 2>&1; then
    echo "[ERROR] ElizaOS server did not come up within timeout" >&2
    echo "[DEBUG] Server PID check: $(kill -0 "$SERVER_PID" 2>/dev/null && echo "alive" || echo "dead")" >&2
    echo "[DEBUG] Final curl test result:" >&2
    curl -v "$TEST_SERVER_URL/api/agents" 2>&1 || true
    echo "--- SERVER LOG ---" >&2
    cat "$TEST_TMP_DIR/server.log" >&2
    echo "------------------" >&2
    exit 1
  fi

  # Pre‑load three reference character files.
  echo "[DEBUG] Pre-loading reference characters..." >&2
  for c in ada max shaw; do
    echo "[DEBUG] Loading character: $c" >&2
    echo "[DEBUG] Character file: $BATS_TEST_DIRNAME/test-characters/$c.json" >&2
    echo "[DEBUG] Command: $ELIZAOS_CMD agent start --remote-url $TEST_SERVER_URL --path $BATS_TEST_DIRNAME/test-characters/$c.json" >&2
    
    if ! $ELIZAOS_CMD agent start --remote-url "$TEST_SERVER_URL" \
      --path "$BATS_TEST_DIRNAME/test-characters/$c.json"; then
      echo "[ERROR] Failed to load character $c" >&2
      echo "--- SERVER LOG (last 50 lines) ---" >&2
      tail -50 "$TEST_TMP_DIR/server.log" >&2
      echo "----------------------------------" >&2
      exit 1
    fi
    echo "[DEBUG] Successfully loaded character: $c" >&2
  done
  sleep 2  # give them a moment to register
}

teardown_file() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  [[ -n "${TEST_TMP_DIR:-}" ]] && rm -rf "$TEST_TMP_DIR"
}

# -----------------------------------------------------------------------------
# Basic help / listing
# -----------------------------------------------------------------------------
@test "agent help displays usage information" {
  run $ELIZAOS_CMD agent --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos agent"* ]]
}

@test "agent list returns agents" {
  run $ELIZAOS_CMD agent list --remote-url "$TEST_SERVER_URL"
  [ "$status" -eq 0 ]
  [[ "$output" =~ (Ada|Max|Shaw) ]]
}

@test "agent list works with JSON flag" {
  run $ELIZAOS_CMD agent list --remote-url "$TEST_SERVER_URL" --json
  [ "$status" -eq 0 ]
  [[ "$output" == *"["* ]] && [[ "$output" == *"{"* ]]
  [[ "$output" =~ ("name"|"Name") ]]
}

# -----------------------------------------------------------------------------
# agent get
# -----------------------------------------------------------------------------
@test "agent get shows details with name parameter" {
  run $ELIZAOS_CMD agent get --remote-url "$TEST_SERVER_URL" -n Ada
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ada"* ]]
}

@test "agent get with JSON flag shows character definition" {
  run $ELIZAOS_CMD agent get --remote-url "$TEST_SERVER_URL" -n Ada --json
  [ "$status" -eq 0 ]
  [[ "$output" =~ ("name"|"Name") ]] && [[ "$output" == *"Ada"* ]]
}

@test "agent get with output flag saves to file" {
  OUTPUT_FILE="$TEST_TMP_DIR/output_ada.json"
  rm -f "$OUTPUT_FILE"
  run $ELIZAOS_CMD agent get --remote-url "$TEST_SERVER_URL" -n Ada --output "$OUTPUT_FILE"
  [ "$status" -eq 0 ]
  [ -f "$OUTPUT_FILE" ]
  [[ "$(cat "$OUTPUT_FILE")" == *"Ada"* ]]
}

# -----------------------------------------------------------------------------
# agent start
# -----------------------------------------------------------------------------
@test "agent start loads character from file" {
  run $ELIZAOS_CMD agent start --remote-url "$TEST_SERVER_URL" --path "$BATS_TEST_DIRNAME/test-characters/ada.json"
  if [ "$status" -eq 0 ]; then
    [[ "$output" =~ (started successfully|created) ]]
  else
    [[ "$output" =~ (already exists|already running) ]]
  fi
}

@test "agent start works with name parameter" {
  run $ELIZAOS_CMD agent start --remote-url "$TEST_SERVER_URL" -n Ada
  [ "$status" -eq 0 ] || [[ "$output" =~ already ]]
}

@test "agent start handles non-existent agent fails" {
  run $ELIZAOS_CMD agent start --remote-url "$TEST_SERVER_URL" -n "NonExistent_$$"
  [ "$status" -ne 0 ] || [[ "$output" =~ (No character configuration provided|not found|No agent found|error) ]]
}

# -----------------------------------------------------------------------------
# agent stop
# -----------------------------------------------------------------------------
@test "agent stop works after start" {
  $ELIZAOS_CMD agent start --remote-url "$TEST_SERVER_URL" -n Ada || true
  run $ELIZAOS_CMD agent stop --remote-url "$TEST_SERVER_URL" -n Ada
  if [ "$status" -eq 0 ]; then
    [[ "$output" =~ (stopped|Stopped) ]]
  else
    [[ "$output" =~ (not running|not found) ]]
  fi
}

# -----------------------------------------------------------------------------
# agent set
# -----------------------------------------------------------------------------
@test "agent set updates configuration correctly" {
  CONFIG_FILE="$TEST_TMP_DIR/update_config.json"
  cat > "$CONFIG_FILE" <<'EOF'
{
  "system": "Updated system prompt for testing"
}
EOF
  run $ELIZAOS_CMD agent set --remote-url "$TEST_SERVER_URL" -n Ada -f "$CONFIG_FILE"
  [ "$status" -eq 0 ]
  [[ "$output" =~ (updated|Updated) ]]
}

# -----------------------------------------------------------------------------
# Full lifecycle
# -----------------------------------------------------------------------------
@test "agent full lifecycle management" {
  run $ELIZAOS_CMD agent start --remote-url "$TEST_SERVER_URL" -n Ada
  [ "$status" -eq 0 ] || [[ "$output" =~ already ]]

  run $ELIZAOS_CMD agent stop --remote-url "$TEST_SERVER_URL" -n Ada
  [ "$status" -eq 0 ] || [[ "$output" =~ "not running" ]]
}
