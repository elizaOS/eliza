#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-XXXXXX)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"
  cd "$TEST_TMP_DIR"
}

teardown() {
  if [ -n "$TEST_TMP_DIR" ] && [[ "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]]; then
    rm -rf "$TEST_TMP_DIR"
  fi
}

@test "create --help shows usage" {
  run $ELIZAOS_CMD create --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos create"* ]]
}

@test "create default project succeeds" {
  run $ELIZAOS_CMD create my-default-app --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Project initialized successfully!"* ]]
  [ -d "my-default-app" ]
  [ -f "my-default-app/package.json" ]
  [ -d "my-default-app/src" ]
}

@test "create plugin project succeeds" {
  run $ELIZAOS_CMD create my-plugin-app --yes --type plugin
  [ "$status" -eq 0 ]
  [[ "$output" == *"Plugin initialized successfully!"* ]]
  if [ -d "my-plugin-app" ]; then
    plugin_dir="my-plugin-app"
  else
    plugin_dir="plugin-my-plugin-app"
  fi
  [ -d "$plugin_dir" ]
  [ -f "$plugin_dir/package.json" ]
  [ -f "$plugin_dir/src/index.ts" ]
}

@test "rejects creating project in existing directory (expected failure or warning)" {
  mkdir -p existing-app
  [ -d "existing-app" ] # Ensure it exists
  run $ELIZAOS_CMD create existing-app --yes
  if [ "$status" -eq 0 ]; then
    # Accept as success if output warns about existing directory
    if [[ "$output" == *"already exists"* ]]; then
      echo "Command succeeded but warned about existing directory. Accepting as success."
      return 0
    fi
    echo "Expected failure or warning, but command succeeded without warning!"
    echo "Output: $output"
    false
  fi
  [[ "$output" == *"already exists"* ]] || [[ "$error" == *"already exists"* ]]
}

@test "create project in current directory" {
  mkdir create-in-place && cd create-in-place
  run $ELIZAOS_CMD create . --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Project initialized successfully!"* ]]
  [ -f "package.json" ]
}

@test "rejects invalid project name" {
  run $ELIZAOS_CMD create "Invalid Name" --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"Invalid"* ]] || [[ "$error" == *"Invalid"* ]]
}

@test "rejects invalid project type" {
  run $ELIZAOS_CMD create bad-type-proj --yes --type bad-type
  [ "$status" -ne 0 ]
  [[ "$output" == *"Invalid type"* ]] || [[ "$error" == *"Invalid type"* ]]
}
