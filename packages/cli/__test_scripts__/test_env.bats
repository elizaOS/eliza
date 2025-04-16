#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d)"
  export ELIZAOS_CMD="bun run ../dist/index.js"
  cd "$TEST_TMP_DIR"
}

teardown() {
  rm -rf "$TEST_TMP_DIR"
}

@test "env --help shows usage" {
  run $ELIZAOS_CMD env --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos env"* ]]
}
