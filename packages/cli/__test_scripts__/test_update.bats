#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-update-XXXXXX)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"
  cd "$TEST_TMP_DIR"
}

teardown() {
  if [ -n "$TEST_TMP_DIR" ] && [[ "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]]; then
    rm -rf "$TEST_TMP_DIR"
  fi
}

# Checks that update --help shows usage
@test "update --help shows usage" {
  run $ELIZAOS_CMD update --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos update"* ]]
  # Verify the help shows all consolidated options
  [[ "$output" == *"--cli"* ]]
  [[ "$output" == *"--packages"* ]]
  [[ "$output" == *"--check"* ]]
  [[ "$output" == *"--skip-build"* ]]
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

# Test the --packages flag
@test "update --packages works" {
  run $ELIZAOS_CMD create update-packages-app --yes
  [ "$status" -eq 0 ]
  cd update-packages-app
  run $ELIZAOS_CMD update --packages
  [ "$status" -eq 0 ] || [[ "$output" == *"already up to date"* ]]
}

# Test the --cli flag
@test "update --cli works" {
  run $ELIZAOS_CMD update --cli
  [ "$status" -eq 0 ]
}

# Test combined flags
@test "update --cli --packages works" {
  run $ELIZAOS_CMD create update-combined-app --yes
  [ "$status" -eq 0 ]
  cd update-combined-app
  run $ELIZAOS_CMD update --cli --packages
  [ "$status" -eq 0 ] || [[ "$output" == *"already up to date"* ]]
}

# Checks that update succeeds outside a project.
# Update is still expected to run outside a project with appropriate warnings.
@test "update succeeds outside a project" {
  run $ELIZAOS_CMD update
  [ "$status" -eq 0 ]
}
