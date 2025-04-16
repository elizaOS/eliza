#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d)"
  export ELIZAOS_CMD="bun run ../dist/index.js"
  cd "$TEST_TMP_DIR"
}

teardown() {
  rm -rf "$TEST_TMP_DIR"
}

# Checks that the test help command displays usage information.
# Verifies that the test help command returns a successful exit status.
# Verifies that the test help command output contains usage information.
@test "test help displays usage information and exits successfully" {
  run $ELIZAOS_CMD test --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos test"* ]]
}
