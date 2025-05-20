#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-env-XXXXXX)"
  # Use a direct absolute path to the index.js file
  export ELIZAOS_CMD="bun run $(cd "$(dirname "$BATS_TEST_DIRNAME")" && pwd)/dist/index.js"
  cd "$TEST_TMP_DIR"
}

teardown() {
  rm -rf "$TEST_TMP_DIR"
}

# Checks that the env help command displays usage information.
@test "env --help shows usage" {
  run $ELIZAOS_CMD env --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos env"* ]]
}

# Checks that env list shows both global and local environments, with appropriate messaging
@test "env list shows environment variables" {
  # Run env list in a directory without .env
  run $ELIZAOS_CMD env list
  [ "$status" -eq 0 ]
  [[ "$output" == *"System Information"* ]]
  [[ "$output" == *"Global Environment Variables"* ]]
  [[ "$output" == *"Local Environment Variables"* ]]
  # Should show warning when no local .env exists
  [[ "$output" == *"No local .env file found"* ]]
  [[ "$output" == *"Missing .env file"* ]]
  
  # Create a local .env file and check again
  echo "TEST_VAR=test_value" > .env
  run $ELIZAOS_CMD env list
  [ "$status" -eq 0 ]
  [[ "$output" == *"TEST_VAR"* ]]
  [[ "$output" == *"test_value"* ]]
}

# Checks that env list --local shows only local env vars
@test "env list --local shows only local environment" {
  # Create local .env
  echo "LOCAL_TEST=local_value" > .env
  
  run $ELIZAOS_CMD env list --local
  [ "$status" -eq 0 ]
  [[ "$output" == *"LOCAL_TEST"* ]]
  [[ "$output" == *"local_value"* ]]
  [[ "$output" != *"System Information"* ]]
  [[ "$output" != *"Global Environment Variables"* ]]
}

# Checks that env list --global shows only global env vars
@test "env list --global shows only global environment" {
  run $ELIZAOS_CMD env list --global
  [ "$status" -eq 0 ]
  [[ "$output" == *"Global environment variables"* ]]
  [[ "$output" != *"System Information"* ]]
  [[ "$output" != *"Local environment variables"* ]]
}

# Checks that env edit-local creates a local .env file if missing
@test "env edit-local creates local .env if missing" {
  # Create a script to automatically accept creating the file
  cat > test-script.sh << 'EOF'
#!/bin/bash
echo -e "y\n" | $ELIZAOS_CMD env edit-local
EOF
  chmod +x test-script.sh
  
  # Verify .env doesn't exist initially
  [ ! -f ".env" ]
  
  # Run the script
  ./test-script.sh
  
  # Verify .env was created
  [ -f ".env" ]
}

# Test env reset functionality with --yes flag to avoid interactive prompts
@test "env reset shows all necessary options" {
  # Use the --yes flag to avoid interactive prompts
  run $ELIZAOS_CMD env reset --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Reset Summary"* ]]
  # Check for expected categories in output
  [[ "$output" == *"Global environment variables"* ]] || [[ "$output" == *"Skipped:"* ]]
  [[ "$output" == *"Local environment variables"* ]] || [[ "$output" == *"Skipped:"* ]]
  [[ "$output" == *"Environment reset complete"* ]]
}
