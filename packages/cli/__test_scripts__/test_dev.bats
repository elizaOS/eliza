#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-dev-XXXXXX)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"
  cd "$TEST_TMP_DIR"
}

teardown() {
  if [ -n "$TEST_TMP_DIR" ] && [[ "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]]; then
    rm -rf "$TEST_TMP_DIR"
  fi
}

# Checks that the dev help command displays usage information.
@test "dev --help shows usage" {
  run $ELIZAOS_CMD dev --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos dev"* ]]
}
