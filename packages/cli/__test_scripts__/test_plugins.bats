#!/usr/bin/env bats

setup_file() {
  # Pre-populate the plugin registry before running tests
  pushd ../../../ >/dev/null
  bun run packages/cli/src/utils/parse-registry.ts
  popd >/dev/null
}

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-plugins-XXXXXX)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"
  cd "$TEST_TMP_DIR"
}

teardown() {
  if [ -n "$TEST_TMP_DIR" ] && [[ "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]]; then
    rm -rf "$TEST_TMP_DIR"
  fi
}

# Create a project for plugin command testing (helper function)
create_test_project() {
  local project_name="$1"
  run $ELIZAOS_CMD create $project_name --yes
  [ "$status" -eq 0 ]
  cd $project_name
}

# Test 1: Main plugins command shows help
@test "plugins command shows help with no subcommand" {
  run $ELIZAOS_CMD plugins
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Manage ElizaOS plugins"* ]]
  [[ "$output" == *"Commands:"* ]]
  [[ "$output" == *"list"* ]]
  [[ "$output" == *"add"* ]]
  [[ "$output" == *"installed-plugins"* ]]
  [[ "$output" == *"remove"* ]]
}

# Test 2: Explicit help flag works
@test "plugins --help shows usage information" {
  run $ELIZAOS_CMD plugins --help
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Manage ElizaOS plugins"* ]]
}

# Test 3: List command shows available plugins
@test "plugins list shows available plugins" {
  run $ELIZAOS_CMD plugins list
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Available plugins"* ]]
  # Check for a few standard plugins that should be in the list
  [[ "$output" == *"plugin-openai"* ]]
  [[ "$output" == *"plugin-sql"* ]]
}

# Test 4: List command aliases work
@test "plugins list aliases (l, ls) work correctly" {
  run $ELIZAOS_CMD plugins l
  [ "$status" -eq 0 ]
  [[ "$output" == *"Available plugins"* ]]
  
  run $ELIZAOS_CMD plugins ls
  [ "$status" -eq 0 ]
  [[ "$output" == *"Available plugins"* ]]
}

# Test 5: Add command installs a plugin
@test "plugins add installs a plugin" {
  create_test_project "test-add-project"
  run $ELIZAOS_CMD plugins add @elizaos/plugin-sql --no-env-prompt
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  # Verify the plugin was added to package.json
  grep '@elizaos/plugin-sql' package.json
}

# Test 6: Add command install alias works
@test "plugins install alias works" {
  create_test_project "test-install-alias"
  run $ELIZAOS_CMD plugins install @elizaos/plugin-openai --no-env-prompt
  [ "$status" -eq 0 ]
  grep '@elizaos/plugin-openai' package.json
}

# Test 7: Installed-plugins command lists installed plugins
@test "plugins installed-plugins shows installed plugins" {
  create_test_project "test-installed-project"
  # Add a plugin
  run $ELIZAOS_CMD plugins add @elizaos/plugin-openai --no-env-prompt
  [ "$status" -eq 0 ]
  # List installed plugins
  run $ELIZAOS_CMD plugins installed-plugins
  [ "$status" -eq 0 ]
  [[ "$output" == *"@elizaos/plugin-openai"* ]]
}

# Test 8: Remove command removes a plugin
@test "plugins remove uninstalls a plugin" {
  create_test_project "test-remove-project"
  # First add a plugin
  run $ELIZAOS_CMD plugins add @elizaos/plugin-sql --no-env-prompt
  [ "$status" -eq 0 ]
  grep '@elizaos/plugin-sql' package.json
  # Then remove it
  run $ELIZAOS_CMD plugins remove @elizaos/plugin-sql
  [ "$status" -eq 0 ]
  # Verify it's gone from package.json
  run grep '@elizaos/plugin-sql' package.json || true
  [[ "$output" != *"@elizaos/plugin-sql"* ]]
}

# Test 9: Remove command aliases work
@test "plugins remove aliases (delete, del, rm) work" {
  create_test_project "test-remove-aliases"
  
  # Test delete alias
  run $ELIZAOS_CMD plugins add @elizaos/plugin-sql --no-env-prompt
  [ "$status" -eq 0 ]
  run $ELIZAOS_CMD plugins delete @elizaos/plugin-sql
  [ "$status" -eq 0 ]
  
  # Test del alias
  run $ELIZAOS_CMD plugins add @elizaos/plugin-openai --no-env-prompt
  [ "$status" -eq 0 ]
  run $ELIZAOS_CMD plugins del @elizaos/plugin-openai
  [ "$status" -eq 0 ]
  
  # Test rm alias
  run $ELIZAOS_CMD plugins add @elizaos/plugin-anthropic --no-env-prompt
  [ "$status" -eq 0 ]
  run $ELIZAOS_CMD plugins rm @elizaos/plugin-anthropic
  [ "$status" -eq 0 ]
}

# Test 10: Add command supports third-party plugin installation
@test "plugins add supports third-party plugins" {
  create_test_project "test-third-party"
  run $ELIZAOS_CMD plugins add @fleek-platform/eliza-plugin-mcp --no-env-prompt
  [ "$status" -eq 0 ]
  grep '@fleek-platform/eliza-plugin-mcp' package.json
}

# Test 11: Add command supports GitHub URL formats
@test "plugins add supports GitHub URL installation" {
  create_test_project "test-github-url"
  # Test direct URL
  run $ELIZAOS_CMD plugins add https://github.com/fleek-platform/eliza-plugin-mcp --no-env-prompt
  [ "$status" -eq 0 ]
  # Test shorthand format
  create_test_project "test-github-shorthand"
  run $ELIZAOS_CMD plugins add github:elizaos-plugins/plugin-openrouter#1.x --no-env-prompt
  [ "$status" -eq 0 ]
  grep 'github:elizaos-plugins/plugin-openrouter#1.x' package.json
}

# The following tests came from v2-develop and were added to ensure compatibility

# Verifies that plugins add command adds a plugin.
@test "plugins add command adds plugin" {
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
  run $ELIZAOS_CMD plugins add @elizaos/plugin-discord --no-env-prompt
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  grep '@elizaos/plugin-discord' package.json
}

# Verifies that attempting to install a plugin not listed in the registry fails.
@test "plugins add fails for missing plugin" {
  run $ELIZAOS_CMD create proj-missing-plugin --yes
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  cd proj-missing-plugin
  run $ELIZAOS_CMD plugins add missing --no-env-prompt
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -ne 0 ]
  [[ "$output" == *"not found in registry"* ]] || [[ "$error" == *"not found in registry"* ]]
}

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

# Verifies that plugins can be installed via a direct GitHub HTTPS URL
@test "plugins add via direct GitHub URL" {
  run $ELIZAOS_CMD create proj-direct-github-url-app --yes
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  cd proj-direct-github-url-app
  run $ELIZAOS_CMD plugins add https://github.com/fleek-platform/eliza-plugin-mcp --no-env-prompt
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  grep '@fleek-platform/eliza-plugin-mcp' package.json
  [ -d "node_modules/@fleek-platform/eliza-plugin-mcp" ]
}

# Verifies that plugins can be installed via GitHub shorthand URL
@test "plugins add via GitHub shorthand URL" {
  run $ELIZAOS_CMD create proj-shorthand-github-url-app --yes
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  cd proj-shorthand-github-url-app
  # Using the same plugin for consistency in checks
  run $ELIZAOS_CMD plugins add github:elizaos-plugins/plugin-openrouter#1.x --no-env-prompt
  echo "STDOUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  grep 'github:elizaos-plugins/plugin-openrouter#1.x' package.json
  [ -d "node_modules/@elizaos/plugin-openrouter" ]
}
