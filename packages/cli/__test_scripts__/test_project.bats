#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"
  cd "$TEST_TMP_DIR"
}

teardown() {
  rm -rf "$TEST_TMP_DIR"
}

# Checks that the project help command displays usage information.
@test "project help displays usage information" {
  # Already present
}

# Verifies that project creation works and creates the expected directory.
@test "project create command creates project directory" {
  run $ELIZAOS_CMD create my-proj-app --yes
  [ "$status" -eq 0 ]
  cd my-proj-app
  [ -f "package.json" ]
}

# Verifies that project installed-plugins command lists installed plugins.
@test "project installed-plugins command lists installed plugins" {
  run $ELIZAOS_CMD create proj-plugin-app --yes
  [ "$status" -eq 0 ]
  cd proj-plugin-app
  run $ELIZAOS_CMD project add-plugin @elizaos/plugin-openai --no-env-prompt
  [ "$status" -eq 0 ]
  run $ELIZAOS_CMD project installed-plugins
  [ "$status" -eq 0 ]
  [[ "$output" == *"@elizaos/plugin-openai"* ]]
}

# Verifies that project add-plugin command adds a plugin to the project.
@test "project add-plugin command adds plugin to project" {
  run $ELIZAOS_CMD create proj-add-app --yes
  [ "$status" -eq 0 ]
  cd proj-add-app
  run $ELIZAOS_CMD project add-plugin @elizaos/plugin-sql --no-env-prompt
  [ "$status" -eq 0 ]
  grep '@elizaos/plugin-sql' package.json
}

@test "project remove-plugin" {
  run $ELIZAOS_CMD create proj-remove-app --yes
  [ "$status" -eq 0 ]
  cd proj-remove-app
  run $ELIZAOS_CMD project add-plugin @elizaos/plugin-sql --no-env-prompt
  [ "$status" -eq 0 ]
  run $ELIZAOS_CMD project remove-plugin @elizaos/plugin-sql
  [ "$status" -eq 0 ]
  ! grep '@elizaos/plugin-sql' package.json
}

@test "project modifies package.json" {
  run $ELIZAOS_CMD create proj-mod-app --yes
  [ "$status" -eq 0 ]
  cd proj-mod-app
  run $ELIZAOS_CMD project add-plugin @elizaos/plugin-bootstrap --no-env-prompt
  [ "$status" -eq 0 ]
  grep '@elizaos/plugin-bootstrap' package.json
}

  run $ELIZAOS_CMD project --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos project"* ]]
}
