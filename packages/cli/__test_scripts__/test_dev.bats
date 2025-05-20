#!/usr/bin/env bats

# -----------------------------------------------------------------------------
# dev‑command integration tests.  These tests spin up a live "elizaos dev"
# instance (which is a long‑running process) in a temp workspace and inspect the
# log output to ensure the flags are wired through correctly and the optional
# build hook runs.
# -----------------------------------------------------------------------------

setup() {
  set -euo pipefail

  # Isolated workspace for every test case.
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-dev-XXXXXX)"
  cd "$TEST_TMP_DIR"

  # Resolve CLI entry point; allow caller override.
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run $(cd "$BATS_TEST_DIRNAME/../dist" && pwd)/index.js}"
}

teardown() {
  # Cleanup any lingering dev instances
  local pids=$(pgrep -f "bun .*elizaos dev" 2>/dev/null)
  if [[ -n "$pids" ]]; then
    echo "Terminating dev processes: $pids"
    kill $pids 2>/dev/null || pkill -f "bun .*elizaos dev" 2>/dev/null || true
    # Wait up to 5 seconds for processes to terminate gracefully
    for i in {1..5}; do
      pgrep -f "bun .*elizaos dev" >/dev/null || break
      sleep 1
    done
    # Force kill if still running
    pkill -9 -f "bun .*elizaos dev" 2>/dev/null || true
  fi

  # Safely cleanup test directory
  if [[ -n "${TEST_TMP_DIR:-}" && "$TEST_TMP_DIR" =~ ^/var/tmp/eliza-test-[a-zA-Z0-9]+$ ]]; then
    echo "Cleaning up test directory: $TEST_TMP_DIR"
    rm -rf "$TEST_TMP_DIR" || true
  fi
}

# -----------------------------------------------------------------------------
# Helpers to scaffold tiny projects on the fly.
# -----------------------------------------------------------------------------
setup_test_project() {
  mkdir -p src
  cat > package.json <<'EOF'
{
  "name": "test-project",
  "version": "1.0.0",
  "eliza": { "type": "project" },
  "scripts": {
    "build": "echo 'Build ran' > build.log"
  }
}
EOF
  cat > src/index.ts <<'EOF'
console.log('Starting test project');
export const project = { name: 'Test Project' };
EOF
}

setup_buildable_project() {
  setup_test_project
  cat > package.json <<'EOF'
{
  "name": "test-project",
  "version": "1.0.0",
  "eliza": { "type": "project" },
  "scripts": {
    "build": "echo 'Build executed at $(date)' > build.log && mkdir -p dist && echo 'console.log(\"Built output\");' > dist/index.js"
  }
}
EOF
}

# -----------------------------------------------------------------------------
# dev --help
# -----------------------------------------------------------------------------
@test "dev --help shows usage" {
  run $ELIZAOS_CMD dev --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos dev"* ]]
}

@test "dev --help shows all options" {
  run $ELIZAOS_CMD dev --help
  [ "$status" -eq 0 ]
  for opt in --configure --character --build --port; do
    [[ "$output" == *"$opt"* ]]
  done
}

# -----------------------------------------------------------------------------
# --character flag parsing (does not actually start the server)
# -----------------------------------------------------------------------------
@test "dev --character accepts single option" {
  run $ELIZAOS_CMD dev --character test.json --help
  [ "$status" -eq 0 ]
}

@test "dev --character accepts multiple character formats" {
  run $ELIZAOS_CMD dev --character "test1.json,test2.json" --help
  [ "$status" -eq 0 ]

  run $ELIZAOS_CMD dev --character "test1.json test2.json" --help
  [ "$status" -eq 0 ]

  run $ELIZAOS_CMD dev --character "'test.json'" --help
  [ "$status" -eq 0 ]
}

# -----------------------------------------------------------------------------
# --port flag propagates to the underlying start command
# -----------------------------------------------------------------------------
@test "dev --port properly passes port to server" {
  setup_test_project
  $ELIZAOS_CMD dev --port 3400 > output.log 2>&1 &
  local dev_pid=$!
  local timeout=30
  local start_time=$(date +%s)
  local found=false
  while [ $(( $(date +%s) - start_time )) -lt $timeout ]; do
    if grep -q "Starting server.*port.*3400" output.log; then
      found=true
      break
    fi
    sleep 1
  done
  [ "$found" = true ] || {
    echo "Timeout waiting for server to start on port 3400"
    kill "$dev_pid" 2>/dev/null
    return 1
  }

  kill -0 "$dev_pid" 2>/dev/null  # process should still be running
  [ "$?" -eq 0 ]

  run cat output.log
  [ "$status" -eq 0 ]
  [[ "$output" =~ (Starting server.*port.*3400|Server.*listening.*3400) ]]

  kill "$dev_pid" 2>/dev/null
}

# -----------------------------------------------------------------------------
# --build flag runs project build script
# -----------------------------------------------------------------------------
@test "dev --build triggers project build" {
  setup_buildable_project

  $ELIZAOS_CMD dev --build > output.log 2>&1 &
  local dev_pid=$!
  local timeout=30
  local start_time=$(date +%s)
  local found=false
  while [ $(( $(date +%s) - start_time )) -lt $timeout ]; do
    if grep -q "Build executed" output.log; then
      found=true
      break
    fi
    sleep 1
  done
  [ "$found" = true ] || {
    echo "Timeout waiting for build to execute"
    kill "$dev_pid" 2>/dev/null
    return 1
  }

  [ -f build.log ]
  run cat build.log
  [ "$status" -eq 0 ]
  [[ "$output" == *"Build executed at"* ]]

  kill "$dev_pid" 2>/dev/null
}

# -----------------------------------------------------------------------------
# File‑watcher rebuild
# -----------------------------------------------------------------------------
@test "dev rebuilds project on file changes" {
  setup_buildable_project

  $ELIZAOS_CMD dev > output.log 2>&1 &
  local dev_pid=$!
  local timeout=30
  local start_time=$(date +%s)
  local found=false
  while [ $(( $(date +%s) - start_time )) -lt $timeout ]; do
    if grep -q "AgentServer is listening" output.log; then
      found=true
      break
    fi
    sleep 1
  done
  [ "$found" = true ] || {
    echo "Timeout waiting for AgentServer to start"
    kill "$dev_pid" 2>/dev/null
    return 1
  }

  echo "// Modified" >> src/index.ts
  sleep 6  # watcher debounce + build time

  run cat output.log
  [ "$status" -eq 0 ]
  [[ "$output" == *"Rebuilding project after file change"* ]]

  kill "$dev_pid" 2>/dev/null
}

# -----------------------------------------------------------------------------
# --configure passthrough
# -----------------------------------------------------------------------------
@test "dev --configure passes configuration option to start" {
  setup_test_project
  $ELIZAOS_CMD dev --configure > output.log 2>&1 &
  local dev_pid=$!
  local timeout=30
  local start_time=$(date +%s)
  local found=false
  while [ $(( $(date +%s) - start_time )) -lt $timeout ]; do
    if grep -F "--configure" output.log; then
      found=true
      break
    fi
    sleep 1
  done
  [ "$found" = true ] || {
    echo "Timeout waiting for --configure option"
    kill "$dev_pid" 2>/dev/null
    return 1
  }

  run cat output.log
  [ "$status" -eq 0 ]
  [[ "$output" == *"--configure"* ]]

  kill "$dev_pid" 2>/dev/null
}

# -----------------------------------------------------------------------------
# All‑in‑one smoke test
# -----------------------------------------------------------------------------
@test "dev integrates all options correctly" {
  setup_buildable_project
  $ELIZAOS_CMD dev --build --port 4567 --configure > output.log 2>&1 &
  local dev_pid=$!
  local timeout=30
  local start_time=$(date +%s)
  local found=false
  while [ $(( $(date +%s) - start_time )) -lt $timeout ]; do
    if grep -q "Starting server.*port.*4567" output.log; then
      found=true
      break
    fi
    sleep 1
  done
  [ "$found" = true ] || {
    echo "Timeout waiting for server to start on port 4567"
    kill "$dev_pid" 2>/dev/null
    return 1
  }

  [ -f build.log ]

  run cat output.log
  [ "$status" -eq 0 ]
  [[ "$output" =~ (--port[[:space:]]+4567|port:[[:space:]]+4567) ]]
  [[ "$output" == *"--configure"* ]]
  [[ "$output" == *"Build"* ]]

  kill "$dev_pid" 2>/dev/null
}
