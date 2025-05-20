#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-dev-XXXXXX)"
  # Use a direct absolute path to the index.js file
  export ELIZAOS_CMD="bun run $(cd "$(dirname "$BATS_TEST_DIRNAME")" && pwd)/dist/index.js"
  cd "$TEST_TMP_DIR"
}

teardown() {
  if [ -n "$TEST_TMP_DIR" ] && [[ "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]]; then
    # Ensure any background processes are stopped
    pkill -f "node.*elizaos" || true
    rm -rf "$TEST_TMP_DIR"
  fi
}

# Create a minimal project structure for testing
setup_test_project() {
  mkdir -p src
  
  # Create a minimal package.json
  cat <<EOF > package.json
{
  "name": "test-project",
  "version": "1.0.0",
  "eliza": { "type": "project" },
  "scripts": {
    "build": "echo 'Build ran' > build.log"
  }
}
EOF

  # Create a simple src/index.ts file
  cat <<EOF > src/index.ts
console.log('Starting test project');
export const project = {
  name: 'Test Project'
};
EOF
}

# Mock a build script that we can verify was executed
setup_buildable_project() {
  setup_test_project
  
  # Create a slightly more advanced package.json with build hooks
  cat <<EOF > package.json
{
  "name": "test-project",
  "version": "1.0.0",
  "eliza": { "type": "project" },
  "scripts": {
    "build": "echo 'Build executed at $(date)' > build.log && mkdir -p dist && echo 'console.log(\"Built output\");' > dist/index.js"
  }
}
EOF
}

# Checks that the dev help command displays usage information.
@test "dev --help shows usage" {
  run $ELIZAOS_CMD dev --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos dev"* ]]
}

# Check that dev command has the right options
@test "dev --help shows all options" {
  run $ELIZAOS_CMD dev --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"--configure"* ]]
  [[ "$output" == *"--character"* ]]
  [[ "$output" == *"--build"* ]]
  [[ "$output" == *"--port"* ]]
}

# Test that dev accepts the character option
@test "dev --character accepts character option" {
  # We don't need to actually start the server, just check that the option is accepted
  run $ELIZAOS_CMD dev --character test.json --help
  [ "$status" -eq 0 ]
}

# Test that dev accepts multiple character formats like the start command
@test "dev --character accepts multiple character formats" {
  # Test comma-separated format
  run $ELIZAOS_CMD dev --character "test1.json,test2.json" --help
  [ "$status" -eq 0 ]
  
  # Test space-separated format
  run $ELIZAOS_CMD dev --character "test1.json test2.json" --help
  [ "$status" -eq 0 ]
  
  # Test quoted format
  run $ELIZAOS_CMD dev --character "'test.json'" --help
  [ "$status" -eq 0 ]
}

# Test that dev accepts the port option and uses it
@test "dev --port properly passes port to server" {
  setup_test_project

  # Start dev process in background with nonstandard port
  $ELIZAOS_CMD dev --port 4999 > output.log 2>&1 &
  local dev_pid=$!
  
  # Allow time for server to start
  sleep 2
  
  # Check logs to ensure port is configured correctly
  run cat output.log
  [[ "$output" == *"--port 4999"* ]] || [[ "$output" == *"port: 4999"* ]]
  
  # Kill the process and clean up
  kill $dev_pid || true
  sleep 1
}

# Test that dev --build option triggers a build
@test "dev --build triggers project build" {
  setup_buildable_project
  
  # Start dev with build flag in background
  $ELIZAOS_CMD dev --build > output.log 2>&1 &
  local dev_pid=$!
  
  # Allow time for build to complete
  sleep 3
  
  # Verify build was executed by checking build.log
  [ -f "build.log" ]
  run cat build.log
  [[ "$output" == *"Build executed at"* ]]
  
  # Kill the process and clean up
  kill $dev_pid || true
  sleep 1
}

# Test that dev rebuilds on file changes
@test "dev rebuilds project on file changes" {
  setup_buildable_project
  
  # Start dev in background
  $ELIZAOS_CMD dev > output.log 2>&1 &
  local dev_pid=$!
  
  # Allow time for initial startup
  sleep 3
  
  # Modify a source file to trigger rebuild
  echo "// Modified file" >> src/index.ts
  
  # Allow time for file watcher to detect and rebuild
  sleep 5
  
  # Verify build was executed after file change
  run cat output.log
  [[ "$output" == *"Rebuilding project after file change"* ]]
  
  # Kill the process and clean up
  kill $dev_pid || true
  sleep 1
}

# Test that dev --configure passes option to start command
@test "dev --configure passes configuration option to start" {
  setup_test_project
  
  # Start dev with configure flag in background
  $ELIZAOS_CMD dev --configure > output.log 2>&1 &
  local dev_pid=$!
  
  # Allow time for server to start
  sleep 2
  
  # Verify --configure was passed to start command
  run cat output.log
  [[ "$output" == *"--configure"* ]]
  
  # Kill the process and clean up
  kill $dev_pid || true
  sleep 1
}

# Integration test to verify all options work together
@test "dev integrates all options correctly" {
  setup_buildable_project
  
  # Start dev with multiple options
  $ELIZAOS_CMD dev --build --port 4567 --configure > output.log 2>&1 &
  local dev_pid=$!
  
  # Allow time for startup sequence
  sleep 4
  
  # Verify build occurred
  [ -f "build.log" ]
  
  # Verify options were passed to start command
  run cat output.log
  [[ "$output" == *"--port 4567"* ]] || [[ "$output" == *"port: 4567"* ]]
  [[ "$output" == *"--configure"* ]]
  [[ "$output" == *"Build"* ]]
  
  # Kill the process and clean up
  kill $dev_pid || true
  sleep 1
}
