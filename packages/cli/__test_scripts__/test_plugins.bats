#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-plugins-XXXXXX)"
  # Get absolute path to the CLI dist directory
  CLI_DIST="$(cd "$(dirname "$BATS_TEST_FILENAME")" && cd ../dist && pwd)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run $CLI_DIST/index.js}"
  cd "$TEST_TMP_DIR"
}

teardown() {
  if [ -n "$TEST_TMP_DIR" ] && [[ "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]]; then
    rm -rf "$TEST_TMP_DIR"
  fi
}

# Verifies that plugins creation works and creates the expected directory.
@test "plugins create command creates plugins directory" {
  run $ELIZAOS_CMD create my-proj-app --yes
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  cd my-proj-app
  [ -f "package.json" ]
}

# Verifies that plugins installed-plugins command lists installed plugins.
@test "plugins installed-plugins command lists installed plugins" {
  run $ELIZAOS_CMD create proj-plugins-app --yes
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  cd proj-plugins-app
  run $ELIZAOS_CMD plugins add @elizaos/plugin-openai --no-env-prompt
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  run $ELIZAOS_CMD plugins installed-plugins
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  [[ "$output" == *"@elizaos/plugin-openai"* ]]
}

# Verifies that plugins add command adds a plugins to the plugins.
@test "plugins add command adds plugins to plugins" {
  run $ELIZAOS_CMD create proj-add-app --yes
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  cd proj-add-app
  run $ELIZAOS_CMD plugins add @elizaos/plugin-sql --no-env-prompt
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  grep '@elizaos/plugin-sql' package.json
}

# Verifies that plugins remove command removes a plugins from the plugins.
@test "plugins remove" {
  run $ELIZAOS_CMD create proj-remove-app --yes
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  cd proj-remove-app
  run $ELIZAOS_CMD plugins add @elizaos/plugin-sql --no-env-prompt
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  run $ELIZAOS_CMD plugins remove @elizaos/plugin-sql
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  ! grep '@elizaos/plugin-sql' package.json
}

# Checks that the plugins modifies package.json.
@test "plugins modifies package.json" {
  run $ELIZAOS_CMD create proj-mod-app --yes
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  cd proj-mod-app
  run $ELIZAOS_CMD plugins add @elizaos/plugin-bootstrap --no-env-prompt
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  grep '@elizaos/plugin-bootstrap' package.json
}

# Checks that the plugins help command displays usage information.
# Verifies that third-party plugins can be installed successfully
@test "plugins add third-party plugin" {
  run $ELIZAOS_CMD create proj-third-party-app --yes
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  cd proj-third-party-app
  run $ELIZAOS_CMD plugins add @fleek-platform/eliza-plugin-mcp --no-env-prompt
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  grep '@fleek-platform/eliza-plugin-mcp' package.json
}

@test "plugins --help shows usage" {
  run $ELIZAOS_CMD plugins --help
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Manage ElizaOS plugins"* ]]
}
