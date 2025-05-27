#!/usr/bin/env bats

# -----------------------------------------------------------------------------
# Test cases for the `elizaos test` command.
# -----------------------------------------------------------------------------

setup() {
  set -euo pipefail

  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-test-XXXXXX)"
  cd "$TEST_TMP_DIR"

  # Point to the built CLI bundle unless caller overrides.
  # Source common utilities
source "$BATS_TEST_DIRNAME/common.sh"
setup_elizaos_cmd
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

# -----------------------------------------------------------------------------
# Filter options
# -----------------------------------------------------------------------------
@test "test command accepts -n option with quotes" {
  run $ELIZAOS_CMD test -n "filter-name" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Filter tests by name"* ]]
}

@test "test command accepts -n option without quotes" {
  run $ELIZAOS_CMD test -n filter-name --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Filter tests by name"* ]]
}

@test "test command accepts --name option" {
  run $ELIZAOS_CMD test --name filter-name --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Filter tests by name"* ]]
}

@test "test component command accepts -n option" {
  run $ELIZAOS_CMD test component -n filter-name --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"component"* ]]
}

@test "test e2e command accepts -n option" {
  run $ELIZAOS_CMD test e2e -n filter-name --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"e2e"* ]]
}

# -----------------------------------------------------------------------------
# Skip build option
# -----------------------------------------------------------------------------
@test "test command accepts --skip-build option" {
  run $ELIZAOS_CMD test --skip-build --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Skip building before running tests"* ]]
}

@test "test command accepts combination of options" {
  run $ELIZAOS_CMD test -n filter-name --skip-build --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Filter tests by name"* ]]
  [[ "$output" == *"Skip building before running tests"* ]]
}

# -----------------------------------------------------------------------------
# Test pattern format handling
# -----------------------------------------------------------------------------
# These tests verify the command accepts different formats of test names
# but don't run actual tests to avoid complexity in the test environment

@test "test command handles basic name format" {
  run $ELIZAOS_CMD test -n basic --help
  [ "$status" -eq 0 ]
}

@test "test command handles .test name format" {
  run $ELIZAOS_CMD test -n basic.test --help
  [ "$status" -eq 0 ]
}

@test "test command handles .test.ts name format" {
  run $ELIZAOS_CMD test -n basic.test.ts --help
  [ "$status" -eq 0 ]
}
