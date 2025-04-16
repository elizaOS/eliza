#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-XXXXXX)"
  export ELIZAOS_CMD="bun run /Users/studio/Documents/GitHub/eliza/packages/cli/dist/index.js"
  cd "$TEST_TMP_DIR"
}

teardown() {
  cd /
  rm -rf "$TEST_TMP_DIR"
}

@test "start --help shows usage" {
  run $ELIZAOS_CMD start --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos start"* ]]
}
