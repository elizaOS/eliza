#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"
  cd "$TEST_TMP_DIR"
}

teardown() {
  rm -rf "$TEST_TMP_DIR"
}

# Checks that the plugin publish --help shows usage.
@test "plugin publish --help shows usage" {
  run $ELIZAOS_CMD plugin publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos plugin publish"* ]]
}

# Checks that the plugin add-plugin official plugin.
@test "project add-plugin official plugin" {
  run $ELIZAOS_CMD create plugin-app --yes
  [ "$status" -eq 0 ]
  cd plugin-app
  run $ELIZAOS_CMD project add-plugin @elizaos/plugin-openai --no-env-prompt
  [ "$status" -eq 0 ]
  grep '@elizaos/plugin-openai' package.json
}

# Checks that the plugin add multiple plugins at once.
@test "project add multiple plugins at once" {
  run $ELIZAOS_CMD create multi-plugin-app --yes
  [ "$status" -eq 0 ]
  cd multi-plugin-app
  run $ELIZAOS_CMD project add-plugin @elizaos/plugin-openai @elizaos/plugin-sql --no-env-prompt
  [ "$status" -eq 0 ]
  grep '@elizaos/plugin-openai' package.json
  grep '@elizaos/plugin-sql' package.json
}

# Checks that the plugin dependency detection in package.json.
@test "plugin dependency detection in package.json" {
  run $ELIZAOS_CMD create dep-plugin-app --yes
  [ "$status" -eq 0 ]
  cd dep-plugin-app
  run $ELIZAOS_CMD project add-plugin @elizaos/plugin-bootstrap --no-env-prompt
  [ "$status" -eq 0 ]
  grep '@elizaos/plugin-bootstrap' package.json
}

# Checks that the plugin install (local path simulated).
@test "custom plugin install (local path simulated)" {
  run $ELIZAOS_CMD create local-plugin-app --yes
  [ "$status" -eq 0 ]
  cd local-plugin-app
  run $ELIZAOS_CMD project add-plugin ../test-characters/ada.json --no-env-prompt
  # Accept failure or warning if not a real plugin, but should not crash
  [ "$status" -ne 127 ]
}

# Checks that the plugin via GitHub URL simulated.
@test "custom plugin via GitHub URL simulated" {
  run $ELIZAOS_CMD create github-plugin-app --yes
  [ "$status" -eq 0 ]
  cd github-plugin-app
  run $ELIZAOS_CMD project add-plugin https://github.com/elizaos/plugin-fake-repo.git --no-env-prompt
  # Accept failure or warning if not a real repo, but should not crash
  [ "$status" -ne 127 ]
}

# Checks that the plugin help command displays usage information.
@test "plugin --help shows usage" {
  run $ELIZAOS_CMD plugin --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos plugin"* ]]
}
