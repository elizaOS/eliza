#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-dev-XXXXXX)"
  # Use a direct absolute path to the index.js file
  export ELIZAOS_CMD="bun run $(cd "$(dirname "$BATS_TEST_DIRNAME")" && pwd)/dist/index.js"
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

# Check that dev command has the right options
@test "dev --help shows all options" {
  run $ELIZAOS_CMD dev --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"--configure"* ]]
  [[ "$output" == *"--character"* ]]
  [[ "$output" == *"--build"* ]]
  [[ "$output" == *"--port"* ]]
}

# Test that dev accepts the character option
@test "dev --character accepts character option" {
  # We don't need to actually start the server, just check that the option is accepted
  run $ELIZAOS_CMD dev --character test.json --help
  [ "$status" -eq 0 ]
}

# Test that dev accepts multiple character formats like the start command
@test "dev --character accepts multiple character formats" {
  # Test comma-separated format
  run $ELIZAOS_CMD dev --character "test1.json,test2.json" --help
  [ "$status" -eq 0 ]
  
  # Test space-separated format
  run $ELIZAOS_CMD dev --character "test1.json test2.json" --help
  [ "$status" -eq 0 ]
  
  # Test quoted format
  run $ELIZAOS_CMD dev --character "'test.json'" --help
  [ "$status" -eq 0 ]
}

# Test that dev accepts the port option
@test "dev --port accepts port number" {
  run $ELIZAOS_CMD dev --port 4000 --help
  [ "$status" -eq 0 ]
}

# Test that dev accepts the build option
@test "dev --build accepts build flag" {
  run $ELIZAOS_CMD dev --build --help
  [ "$status" -eq 0 ]
}

# Test that dev accepts the configure option
@test "dev --configure accepts configure flag" {
  run $ELIZAOS_CMD dev --configure --help
  [ "$status" -eq 0 ]
}
