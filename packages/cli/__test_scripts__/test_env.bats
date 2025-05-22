#!/usr/bin/env bats

# -----------------------------------------------------------------------------
# env‑command tests.  These tests exercise listing, editing and resetting
# environment variable files (.env) in the project directory.
# -----------------------------------------------------------------------------

setup() {
  set -euo pipefail

  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-env-XXXXXX)"
  cd "$TEST_TMP_DIR"

  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run $(cd "$BATS_TEST_DIRNAME/../dist" && pwd)/index.js}"
}

teardown() {
  [[ -n "${TEST_TMP_DIR:-}" ]] && rm -rf "$TEST_TMP_DIR"
}

# -----------------------------------------------------------------------------
# --help
# -----------------------------------------------------------------------------
@test "env --help shows usage" {
  run $ELIZAOS_CMD env --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos env"* ]]
}

# -----------------------------------------------------------------------------
# env list (with and without local .env)
# -----------------------------------------------------------------------------
@test "env list shows environment variables" {
  # First call: no local .env file present.
  run $ELIZAOS_CMD env list
  [ "$status" -eq 0 ]
  for section in "System Information" "Local Environment Variables"; do
    [[ "$output" == *"$section"* ]]
  done
  [[ "$output" == *"No local .env file found"* ]] || [[ "$output" == *"Missing .env file"* ]]

  # Create a local .env file and try again.
  echo "TEST_VAR=test_value" > .env
  run $ELIZAOS_CMD env list
  [ "$status" -eq 0 ]
  [[ "$output" == *"TEST_VAR"* ]]
  [[ "$output" == *"test_value"* ]]
}

# -----------------------------------------------------------------------------
# --local filter
# -----------------------------------------------------------------------------
@test "env list --local shows only local environment" {
  echo "LOCAL_TEST=local_value" > .env
  run $ELIZAOS_CMD env list --local
  [ "$status" -eq 0 ]
  [[ "$output" == *"LOCAL_TEST"* ]] && [[ "$output" == *"local_value"* ]]
  [[ "$output" != *"System Information"* ]]
}


# -----------------------------------------------------------------------------
# env edit-local (auto‑create)
# -----------------------------------------------------------------------------
@test "env edit-local creates local .env if missing" {
  [ ! -f .env ]
  run bash -c 'printf "y\n" | '"$ELIZAOS_CMD"' env edit-local'
  [ "$status" -eq 0 ]
  [ -f .env ]
}

# -----------------------------------------------------------------------------
# env reset
# -----------------------------------------------------------------------------
@test "env reset shows all necessary options" {
  echo "DUMMY=value" > .env
  run $ELIZAOS_CMD env reset --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Reset Summary"* ]]
  [[ "$output" == *"Local environment variables"* ]]
  [[ "$output" == *"Environment reset complete"* ]]
}
