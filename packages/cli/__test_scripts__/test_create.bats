#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-XXXXXX)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"
  export CREATE_ELIZA_CMD="${CREATE_ELIZA_CMD:-bun run "$(cd "$BATS_TEST_DIRNAME/../../create-eliza" && pwd)/index.mjs"}"
  cd "$TEST_TMP_DIR"
}

teardown() {
  if [ -n "$TEST_TMP_DIR" ] && [[ "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]]; then
    rm -rf "$TEST_TMP_DIR"
  fi
}

# Checks that the create help command displays usage information for all types.
@test "create --help shows usage" {
  run $ELIZAOS_CMD create --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos create"* ]]
  # Verify all three types are mentioned
  [[ "$output" == *"project"* ]]
  [[ "$output" == *"plugin"* ]]
  [[ "$output" == *"agent"* ]]
}

# Checks that creating a default project succeeds with all required directories.
@test "create default project succeeds" {
  run $ELIZAOS_CMD create my-default-app --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Project initialized successfully!"* ]]
  [ -d "my-default-app" ]
  [ -f "my-default-app/package.json" ]
  [ -d "my-default-app/src" ]
  # Check for knowledge directory (added in current implementation)
  [ -d "my-default-app/knowledge" ]
  # Check for ignore files
  [ -f "my-default-app/.gitignore" ]
  [ -f "my-default-app/.npmignore" ]
}

# Checks that creating a plugin project succeeds (with plugin- prefix automatically added if needed).
@test "create plugin project succeeds" {
  run $ELIZAOS_CMD create my-plugin-app --yes --type plugin
  [ "$status" -eq 0 ]
  [[ "$output" == *"Plugin initialized successfully!"* ]]
  # The CLI should always add the prefix when missing
  plugin_dir="plugin-my-plugin-app"
  [ -d "$plugin_dir" ]
  [ -f "$plugin_dir/package.json" ]
  [ -f "$plugin_dir/src/index.ts" ]
}

# Checks that creating an agent succeeds.
@test "create agent succeeds" {
  run $ELIZAOS_CMD create my-test-agent --yes --type agent
  [ "$status" -eq 0 ]
  [[ "$output" == *"Agent character created successfully"* ]]
  [ -f "my-test-agent.json" ]
  
  # Verify the JSON file is valid
  run cat "my-test-agent.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"\"name\": \"my-test-agent\""* ]]
  [[ "$output" == *"\"system\":"* ]]
  [[ "$output" == *"\"bio\":"* ]]
  [[ "$output" == *"\"messageExamples\":"* ]]
}

# Checks that creating a project in an existing directory is rejected (expected failure or warning).
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

# Checks that creating a project in the current directory works.
@test "create project in current directory" {
  mkdir create-in-place && cd create-in-place
  run $ELIZAOS_CMD create . --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Project initialized successfully!"* ]]
  [ -f "package.json" ]
}

# Checks that invalid project names are rejected.
@test "rejects invalid project name" {
  run $ELIZAOS_CMD create "Invalid Name" --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"Invalid"* ]] || [[ "$error" == *"Invalid"* ]]
}

# Checks that invalid project types are rejected.
@test "rejects invalid project type" {
  run $ELIZAOS_CMD create bad-type-proj --yes --type bad-type
  [ "$status" -ne 0 ]
  [[ "$output" == *"Invalid type"* ]] || [[ "$error" == *"Invalid type"* ]]
}

# Verifies that the create-eliza command can create a default project successfully.
@test "create-eliza default project succeeds" {
  run $CREATE_ELIZA_CMD my-create-app --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Project initialized successfully!"* ]]
  [ -d "my-create-app" ]
  [ -f "my-create-app/package.json" ]
  [ -d "my-create-app/src" ]
}

# Verifies that the create-eliza command can create a plugin project successfully.
@test "create-eliza plugin project succeeds" {
  run $CREATE_ELIZA_CMD my-create-plugin --yes --type plugin
  [ "$status" -eq 0 ]
  [[ "$output" == *"Plugin initialized successfully!"* ]]
  # The CLI should always add the prefix when missing
  plugin_dir="plugin-my-create-plugin"
  [ -d "$plugin_dir" ]
  [ -f "$plugin_dir/package.json" ]
  [ -f "$plugin_dir/src/index.ts" ]
}

# Verifies that the create-eliza command can create an agent successfully.
@test "create-eliza agent succeeds" {
  run $CREATE_ELIZA_CMD my-create-agent --yes --type agent
  [ "$status" -eq 0 ]
  [[ "$output" == *"Agent character created successfully"* ]]
  [ -f "my-create-agent.json" ]
  
  # Verify the JSON structure
  run cat "my-create-agent.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"\"name\": \"my-create-agent\""* ]]
}
