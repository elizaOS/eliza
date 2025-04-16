#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d)"
  export ELIZAOS_CMD="bun run /Users/studio/Documents/GitHub/eliza/packages/cli/dist/index.js"
  cd "$TEST_TMP_DIR"
}

teardown() {
  rm -rf "$TEST_TMP_DIR"
}

@test "dev --help shows usage" {
  run $ELIZAOS_CMD dev --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos dev"* ]]
}
