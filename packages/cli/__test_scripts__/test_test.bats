#!/usr/bin/env bats

# -----------------------------------------------------------------------------
# Simple smoke‑test for the `elizaos test` command.
# -----------------------------------------------------------------------------

setup() {
  set -euo pipefail

  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-test-XXXXXX)"
  cd "$TEST_TMP_DIR"

  # Point to the built CLI bundle unless caller overrides.
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run $(cd "$BATS_TEST_DIRNAME/../dist" && pwd)/index.js}"
}

teardown() {
  [[ -n "${TEST_TMP_DIR:-}" && "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]] && rm -rf "$TEST_TMP_DIR"
}

# -----------------------------------------------------------------------------
# --help output
# -----------------------------------------------------------------------------
@test "test --help shows usage" {
  run $ELIZAOS_CMD test --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos test"* ]]
}
