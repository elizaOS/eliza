#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"
  cd "$TEST_TMP_DIR"
}

teardown() {
  rm -rf "$TEST_TMP_DIR"
}

# Verifies that plugin creation works and creates the expected directory.
@test "plugin create command creates plugin directory" {
  run $ELIZAOS_CMD create my-proj-app --yes
  [ "$status" -eq 0 ]
  cd my-proj-app
  [ -f "package.json" ]
}

# Verifies that plugin installed-plugins command lists installed plugins.
@test "plugin installed-plugins command lists installed plugins" {
  run $ELIZAOS_CMD create proj-plugin-app --yes
  [ "$status" -eq 0 ]
  cd proj-plugin-app
  run $ELIZAOS_CMD plugin add @elizaos/plugin-openai --no-env-prompt
  [ "$status" -eq 0 ]
  run $ELIZAOS_CMD plugin installed-plugins
  [ "$status" -eq 0 ]
  [[ "$output" == *"@elizaos/plugin-openai"* ]]
}

# Verifies that plugin add command adds a plugin to the plugin.
@test "plugin add command adds plugin to plugin" {
  run $ELIZAOS_CMD create proj-add-app --yes
  [ "$status" -eq 0 ]
  cd proj-add-app
  run $ELIZAOS_CMD plugin add @elizaos/plugin-sql --no-env-prompt
  [ "$status" -eq 0 ]
  grep '@elizaos/plugin-sql' package.json
}

# Verifies that plugin remove command removes a plugin from the plugin.
@test "plugin remove" {
  run $ELIZAOS_CMD create proj-remove-app --yes
  [ "$status" -eq 0 ]
  cd proj-remove-app
  run $ELIZAOS_CMD plugin add @elizaos/plugin-sql --no-env-prompt
  [ "$status" -eq 0 ]
  run $ELIZAOS_CMD plugin remove @elizaos/plugin-sql
  [ "$status" -eq 0 ]
  ! grep '@elizaos/plugin-sql' package.json
}

# Checks that the plugin modifies package.json.
@test "plugin modifies package.json" {
  run $ELIZAOS_CMD create proj-mod-app --yes
  [ "$status" -eq 0 ]
  cd proj-mod-app
  run $ELIZAOS_CMD plugin add @elizaos/plugin-bootstrap --no-env-prompt
  [ "$status" -eq 0 ]
  grep '@elizaos/plugin-bootstrap' package.json
}

# Checks that the plugin help command displays usage information.
@test "plugin --help shows usage" {
  run $ELIZAOS_CMD plugin --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Manage an ElizaOS plugin"* ]]
}
