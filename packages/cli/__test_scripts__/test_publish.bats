#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d)"
  export ELIZAOS_CMD="bun run ../dist/index.js"
  cd "$TEST_TMP_DIR"
}

teardown() {
  rm -rf "$TEST_TMP_DIR"
}

# Checks that the publish help command displays usage information.
@test "plugin publish help displays usage information" {
  run $ELIZAOS_CMD plugin publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos plugin publish"* ]]
}

# Verifies that plugin validation runs in a newly created plugin project directory.
@test "plugin publish validate runs in plugin project" {
  run $ELIZAOS_CMD create my-plugin --yes --type plugin
  echo "$output"
  echo "$error"
  [ "$status" -eq 0 ]
  cd plugin-my-plugin
  run $ELIZAOS_CMD plugin publish --validate
  [ "$status" -ne 127 ]
}

# Checks that plugin packaging runs in a newly created plugin project directory.
@test "plugin publish pack runs in plugin project" {
  run $ELIZAOS_CMD create pkg-plugin --yes --type plugin
  echo "$output"
  echo "$error"
  [ "$status" -eq 0 ]
  cd plugin-pkg-plugin
  run $ELIZAOS_CMD plugin publish --pack
  [ "$status" -ne 127 ]
}

# Ensures plugin publish with authentication flag runs in a plugin project directory.
@test "plugin publish with auth flag runs in plugin project" {
  run $ELIZAOS_CMD create pub-plugin --yes --type plugin
  echo "$output"
  echo "$error"
  [ "$status" -eq 0 ]
  cd plugin-pub-plugin
  run $ELIZAOS_CMD plugin publish --auth fake-token
  [ "$status" -ne 127 ]
}

# Checks that version bumping logic can be triggered in a plugin project directory.
@test "plugin publish bump-version runs in plugin project" {
  run $ELIZAOS_CMD create ver-plugin --yes --type plugin
  echo "$output"
  echo "$error"
  [ "$status" -eq 0 ]
  cd plugin-ver-plugin
  run $ELIZAOS_CMD plugin publish --bump-version
  [ "$status" -ne 127 ]
}

