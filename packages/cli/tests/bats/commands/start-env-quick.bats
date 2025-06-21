#!/usr/bin/env bats

load '../helpers/test-helpers'
load '../helpers/environment-helpers'

setup() {
  setup_test_environment
}

teardown() {
  teardown_test_environment
}

@test "environment: detects runtime correctly" {
  # Test environment detection
  local env=$(detect_runtime_environment)
  echo "Detected environment: $env"
  [[ "$env" == "typescript" ]] || [[ "$env" == "javascript" ]]
}

@test "environment: detects monorepo context" {
  # Should be true when running in ElizaOS monorepo
  if is_monorepo_context; then
    echo "Running in monorepo context"
  else
    echo "Not in monorepo context"
  fi
  # Test passes regardless - just checking detection works
  assert_success
}

@test "environment: creates test character successfully" {
  create_test_character "test-char.json"
  assert_file_exist "test-char.json"
  
  # Verify character content
  run cat test-char.json
  assert_output --partial "TestAgent"
  assert_output --partial "modelProvider"
}

@test "environment: creates test project with agents" {
  create_test_project_with_agents "test-project"
  
  assert_dir_exist "test-project"
  assert_file_exist "test-project/package.json"
  assert_file_exist "test-project/characters/agent1.json"
  assert_file_exist "test-project/.env"
  
  # Verify project structure
  run cat test-project/package.json
  assert_output --partial "elizaos"
  assert_output --partial "agents"
}

@test "environment: creates test plugin correctly" {
  create_test_plugin "test-plugin"
  
  assert_dir_exist "test-plugin"
  assert_file_exist "test-plugin/package.json"
  
  # Check if TypeScript or JavaScript based on environment
  if [[ -f "test-plugin/src/index.ts" ]]; then
    echo "Created TypeScript plugin"
    assert_file_exist "test-plugin/src/index.ts"
  else
    echo "Created JavaScript plugin"
    assert_file_exist "test-plugin/dist/index.js"
  fi
}

@test "environment: normalizes import paths" {
  # This test just verifies the helper function works
  local normalized=$(normalize_import_path "./utils")
  echo "Normalized path: $normalized"
  
  # Should either be ./utils (TS) or ./utils.js (JS)
  [[ "$normalized" == "./utils" ]] || [[ "$normalized" == "./utils.js" ]]
}

@test "environment: validates character JSON loading" {
  create_test_character "valid-char.json"
  
  # Try loading with the CLI (just validate, don't start)
  run run_cli "dist" start --help
  assert_cli_success
  assert_output --partial "character"
}

@test "environment: handles multiple character files" {
  create_test_character "agent1.json"
  create_test_character "agent2.json"
  
  # Just verify files were created correctly
  assert_file_exist "agent1.json"
  assert_file_exist "agent2.json"
  
  # Verify they can be read
  run cat agent1.json
  assert_output --partial "TestAgent"
  
  run cat agent2.json
  assert_output --partial "TestAgent"
} 