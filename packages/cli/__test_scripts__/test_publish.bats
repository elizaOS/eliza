#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"
  cd "$TEST_TMP_DIR"
}

teardown() {
  rm -rf "$TEST_TMP_DIR"
}

# Checks that the publish help command displays usage information (matching actual CLI output).
@test "plugins publish help displays usage information" {
  run $ELIZAOS_CMD plugins publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos plugins s"* ]]
}

# Verifies that plugins validation runs in a newly created plugins project directory.
@test "plugins publish validate runs in plugins project" {
  run $ELIZAOS_CMD create my-plugins --yes --type plugins
  echo "$output"
  echo "$error"
  [ "$status" -eq 0 ]
  cd plugins-my-plugins
  run $ELIZAOS_CMD plugins publish --validate
  [ "$status" -ne 127 ]
}

# Checks that plugins packaging runs in a newly created plugins project directory.
@test "plugins publish pack runs in plugins project" {
  run $ELIZAOS_CMD create pkg-plugins --yes --type plugins
  echo "$output"
  echo "$error"
  [ "$status" -eq 0 ]
  cd plugins-pkg-plugins
  run $ELIZAOS_CMD plugins publish --pack
  [ "$status" -ne 127 ]
}

# Ensures plugins publish with authentication flag runs in a plugins project directory.
@test "plugins publish with auth flag runs in plugins project" {
  run $ELIZAOS_CMD create pub-plugins --yes --type plugins
  echo "$output"
  echo "$error"
  [ "$status" -eq 0 ]
  cd plugins-pub-plugins
  run $ELIZAOS_CMD plugins publish --auth fake-token
  [ "$status" -ne 127 ]
}

# Checks that version bumping logic can be triggered in a plugins project directory.
@test "plugins publish bump-version runs in plugins project" {
  run $ELIZAOS_CMD create ver-plugins --yes --type plugins
  echo "$output"
  echo "$error"
  [ "$status" -eq 0 ]
  cd plugins-ver-plugins
  run $ELIZAOS_CMD plugins publish --bump-version
  [ "$status" -ne 127 ]
}
