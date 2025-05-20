#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-XXXXXX)"
  export ELIZAOS_CMD="bun run $(pwd)/dist/index.js"
  export CREATE_ELIZA_CMD="${CREATE_ELIZA_CMD:-bun run "$(cd "$BATS_TEST_DIRNAME/../../create-eliza" && pwd)/index.mjs"}"
  cd "$TEST_TMP_DIR"
  
  # Check if jq is available, warn if not
  if ! command -v jq &> /dev/null; then
    echo "Warning: jq is not installed. JSON validation will be limited."
  fi
}

teardown() {
  if [ -n "$TEST_TMP_DIR" ] && [[ "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]]; then
    rm -rf "$TEST_TMP_DIR"
  fi
}

# Helper function to validate agent JSON files
validate_agent_json() {
  local json_file="$1"
  local expected_name="$2"
  
  if command -v jq &> /dev/null; then
    # Use jq for proper JSON validation if available
    run jq -e ".name == \"$expected_name\" and .system and .bio and (.messageExamples | length >= 0)" "$json_file"
    [ "$status" -eq 0 ]
  else
    # Fallback to basic pattern matching
    run cat "$json_file"
    [ "$status" -eq 0 ]
    [[ "$output" == *"\"name\": \"$expected_name\""* ]]
    [[ "$output" == *"\"system\":"* ]]
    [[ "$output" == *"\"bio\":"* ]]
    [[ "$output" == *"\"messageExamples\":"* ]]
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
  # Ensure no stray/unexpected tokens are present
  [[ "$output" != *"frobnicate"* ]]
}

# Checks that creating a default project succeeds with all required directories.
@test "create default project succeeds" {
  run $ELIZAOS_CMD create my-default-app --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Project initialized successfully!"* ]]
  [ -d "my-default-app" ]
  if [ ! -d "my-default-app" ]; then
    echo "Project directory was not created!"
    return 1
  fi

  [ -f "my-default-app/package.json" ]
  if [ ! -f "my-default-app/package.json" ]; then
    echo "package.json was not created!"
    return 1
  fi

  [ -d "my-default-app/src" ]
  if [ ! -d "my-default-app/src" ]; then
    echo "src directory was not created!"
    return 1
  fi

  # Check for knowledge directory (added in current implementation)
  [ -d "my-default-app/knowledge" ]
  if [ ! -d "my-default-app/knowledge" ]; then
    echo "knowledge directory was not created!"
    return 1
  fi

  # Check for ignore files
  [ -f "my-default-app/.gitignore" ]
  if [ ! -f "my-default-app/.gitignore" ]; then
    echo ".gitignore file was not created!"
    return 1
  fi

  [ -f "my-default-app/.npmignore" ]
  if [ ! -f "my-default-app/.npmignore" ]; then
    echo ".npmignore file was not created!"
    return 1
  fi
}

# Checks that creating a plugin project succeeds (with plugin- prefix automatically added if needed).
@test "create plugin project succeeds" {
  run $ELIZAOS_CMD create my-plugin-app --yes --type plugin
  [ "$status" -eq 0 ]
  [[ "$output" == *"Plugin initialized successfully!"* ]]
  # The CLI should always add the prefix when missing
  plugin_dir="plugin-my-plugin-app"
  [ -d "$plugin_dir" ]
  if [ ! -d "$plugin_dir" ]; then
    echo "Plugin directory ($plugin_dir) was not created!"
    return 1
  fi

  [ -f "$plugin_dir/package.json" ]
  if [ ! -f "$plugin_dir/package.json" ]; then
    echo "package.json was not created in plugin directory!"
    return 1
  fi

  [ -f "$plugin_dir/src/index.ts" ]
  if [ ! -f "$plugin_dir/src/index.ts" ]; then
    echo "src/index.ts was not created in plugin directory!"
    return 1
  fi
}

# Checks that creating an agent succeeds.
@test "create agent succeeds" {
  run $ELIZAOS_CMD create my-test-agent --yes --type agent
  [ "$status" -eq 0 ]
  [[ "$output" == *"Agent character created successfully"* ]]
  [ -f "my-test-agent.json" ]
  if [ ! -f "my-test-agent.json" ]; then
    echo "Agent JSON file was not created!"
    return 1
  fi
  
  # Verify the JSON file structure using our helper function
  validate_agent_json "my-test-agent.json" "my-test-agent"
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
  if [ ! -f "package.json" ]; then
    echo "package.json was not created in current directory!"
    return 1
  fi
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
  if [ ! -d "my-create-app" ]; then
    echo "Project directory was not created!"
    return 1
  fi

  [ -f "my-create-app/package.json" ]
  if [ ! -f "my-create-app/package.json" ]; then
    echo "package.json was not created!"
    return 1
  fi

  [ -d "my-create-app/src" ]
  if [ ! -d "my-create-app/src" ]; then
    echo "src directory was not created!"
    return 1
  fi
}

# Verifies that the create-eliza command can create a plugin project successfully.
@test "create-eliza plugin project succeeds" {
  run $CREATE_ELIZA_CMD my-create-plugin --yes --type plugin
  [ "$status" -eq 0 ]
  [[ "$output" == *"Plugin initialized successfully!"* ]]
  # The CLI should always add the prefix when missing
  plugin_dir="plugin-my-create-plugin"
  [ -d "$plugin_dir" ]
  if [ ! -d "$plugin_dir" ]; then
    echo "Plugin directory ($plugin_dir) was not created!"
    return 1
  fi

  [ -f "$plugin_dir/package.json" ]
  if [ ! -f "$plugin_dir/package.json" ]; then
    echo "package.json was not created in plugin directory!"
    return 1
  fi

  [ -f "$plugin_dir/src/index.ts" ]
  if [ ! -f "$plugin_dir/src/index.ts" ]; then
    echo "src/index.ts was not created in plugin directory!"
    return 1
  fi
}

# Verifies that the create-eliza command can create an agent successfully.
@test "create-eliza agent succeeds" {
  run $CREATE_ELIZA_CMD my-create-agent --yes --type agent
  [ "$status" -eq 0 ]
  [[ "$output" == *"Agent character created successfully"* ]]
  [ -f "my-create-agent.json" ]
  if [ ! -f "my-create-agent.json" ]; then
    echo "Agent JSON file was not created!"
    return 1
  fi
  
  # Use the helper function to validate agent JSON structure
  validate_agent_json "my-create-agent.json" "my-create-agent"
}
