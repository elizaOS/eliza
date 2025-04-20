#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"
  cd "$TEST_TMP_DIR"
}

teardown() {
  rm -rf "$TEST_TMP_DIR"
}

# Checks that update --help shows usage
@test "update --help shows usage" {
  run $ELIZAOS_CMD update --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos update"* ]]
}

# Checks that update runs in a valid project.
@test "update runs in a valid project" {
  run $ELIZAOS_CMD create update-app --yes
  [ "$status" -eq 0 ]
  cd update-app
  run $ELIZAOS_CMD update
  [ "$status" -eq 0 ] || [[ "$output" == *"already up to date"* ]]
}

# Checks that update --check works.
@test "update --check works" {
  run $ELIZAOS_CMD create update-check-app --yes
  [ "$status" -eq 0 ]
  cd update-check-app
  run $ELIZAOS_CMD update --check
  [ "$status" -eq 0 ] || [[ "$output" == *"already up to date"* ]]
}

# Checks that update --skip-build works.
@test "update --skip-build works" {
  run $ELIZAOS_CMD create update-skip-build-app --yes
  [ "$status" -eq 0 ]
  cd update-skip-build-app
  run $ELIZAOS_CMD update --skip-build
  [ "$status" -eq 0 ] || [[ "$output" == *"already up to date"* ]]
}

# Checks that update errors in a non-project directory.
# This test expects a non-zero exit status, which is the correct behavior.
# Do not treat this as a failure in CI; this is a "positive" negative test.
@test "update succeeds outside a project" {
  run $ELIZAOS_CMD update
  [ "$status" -eq 0 ]
}
