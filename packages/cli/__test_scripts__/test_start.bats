#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-XXXXXX)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"
  cd "$TEST_TMP_DIR"
}

teardown() {
  cd /
  rm -rf "$TEST_TMP_DIR"
}

# Checks that the start help command displays usage information.
@test "start --help shows usage" {
  run $ELIZAOS_CMD start --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos start"* ]]
}
