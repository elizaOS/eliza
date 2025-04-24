#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-env-XXXXXX)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"
  cd "$TEST_TMP_DIR"
}

teardown() {
  rm -rf "$TEST_TMP_DIR"
}

# Checks that the env help command displays usage information.
@test "env --help shows usage" {
  run $ELIZAOS_CMD env --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos env"* ]]
}
