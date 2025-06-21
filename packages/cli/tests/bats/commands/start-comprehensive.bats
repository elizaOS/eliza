#!/usr/bin/env bats

load '../helpers/test-helpers'
load '../helpers/environment-helpers'

# Track background processes for cleanup
BACKGROUND_PIDS=()

setup() {
  setup_test_environment
}

teardown() {
  # Kill any background processes
  for pids in "${BACKGROUND_PIDS[@]}"; do
    if [[ -n "$pids" ]]; then
      if [[ "$pids" == *:* ]]; then
        kill_timeout_processes "$pids"
      else
        kill_process_gracefully "$pids"
      fi
    fi
  done
  
  teardown_test_environment
}

# Test 1: Character file in different environments
@test "start: character file works in TypeScript development (bun run)" {
  # Skip if not in monorepo with bun
  if ! command -v bun >/dev/null 2>&1; then
    skip "bun not available"
  fi
  
  create_test_character "test-char.json"
  
  # Run with bun directly (TypeScript environment)
  cd "$MONOREPO_ROOT"
  local pids=$(start_cli_background_with_timeout "monorepo" 30 start --character "$TEST_DIR/test-char.json")
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  kill_timeout_processes "$pids"
}

@test "start: character file works in JavaScript production (elizaos command)" {
  # This simulates the built/installed CLI
  create_test_character "test-char.json"
  
  local pids=$(start_cli_background_with_timeout "dist" 30 start --character test-char.json)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  kill_timeout_processes "$pids"
}

# Test 2: Project with agents inside monorepo
@test "start: project with agents works inside monorepo" {
  create_test_project_with_agents "monorepo-project"
  cd monorepo-project
  
  # Should load agents from project config
  local pids=$(start_cli_background_with_timeout "dist" 30 start)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  # Verify it loaded the project agent, not default
  # Check logs or process output if needed
  
  kill_timeout_processes "$pids"
}

# Test 3: Project with agents outside monorepo
@test "start: project with agents works outside monorepo (standalone)" {
  # Create a standalone project in a temp directory
  local standalone_dir=$(create_standalone_project "standalone-test")
  cd "$standalone_dir"
  
  # Install dependencies (mock)
  mkdir -p node_modules/@elizaos
  
  local pids=$(start_cli_background_with_timeout "dist" 30 start)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  kill_timeout_processes "$pids"
  
  # Cleanup
  rm -rf "$(dirname "$standalone_dir")"
}

# Test 4: Plugin loading in different environments
@test "start: loads plugin correctly in TypeScript environment" {
  create_test_plugin "ts-plugin" "typescript"
  create_test_character "plugin-char.json"
  
  # Add plugin to character
  local char_content=$(cat plugin-char.json)
  echo "${char_content%?}, \"plugins\": [\"./ts-plugin\"]}" > plugin-char.json
  
  local pids=$(start_cli_background_with_timeout "dist" 30 start --character plugin-char.json)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  kill_timeout_processes "$pids"
}

@test "start: loads plugin correctly in JavaScript environment" {
  create_test_plugin "js-plugin" "javascript"
  create_test_character "plugin-char.json"
  
  # Add plugin to character
  local char_content=$(cat plugin-char.json)
  echo "${char_content%?}, \"plugins\": [\"./js-plugin\"]}" > plugin-char.json
  
  local pids=$(start_cli_background_with_timeout "dist" 30 start --character plugin-char.json)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  kill_timeout_processes "$pids"
}

# Test 5: Project starter template
@test "start: works with project-starter template" {
  # Simulate project-starter structure
  mkdir -p project-starter-test
  cd project-starter-test
  
  # Copy minimal project-starter structure
  cat > package.json <<EOF
{
  "name": "my-eliza-project",
  "version": "1.0.0",
  "type": "module",
  "main": "src/index.js",
  "scripts": {
    "start": "elizaos start",
    "dev": "elizaos start --character characters/main.json"
  },
  "dependencies": {
    "@elizaos/core": "latest",
    "@elizaos/cli": "latest",
    "@elizaos/plugin-message-handling": "latest"
  }
}
EOF

  mkdir -p characters
  create_test_character "characters/main.json"
  
  # Create src directory with index
  mkdir -p src
  echo "export default {}" > src/index.js
  
  local pids=$(start_cli_background_with_timeout "dist" 30 start --character characters/main.json)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  kill_timeout_processes "$pids"
}

# Test 6: Plugin starter template
@test "start: works with plugin-starter template" {
  # Simulate plugin-starter structure
  mkdir -p plugin-starter-test
  cd plugin-starter-test
  
  cat > package.json <<EOF
{
  "name": "@elizaos/plugin-custom",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsup",
    "test": "elizaos test",
    "example": "elizaos start --character examples/character.json"
  },
  "dependencies": {
    "@elizaos/core": "latest"
  }
}
EOF

  # Create example character that uses the plugin
  mkdir -p examples dist
  create_test_character "examples/character.json"
  
  # Create minimal plugin dist
  cat > dist/index.js <<EOF
export const customPlugin = {
  name: '@elizaos/plugin-custom',
  description: 'Custom plugin',
  actions: [],
  providers: [],
  services: []
};
export default customPlugin;
EOF
  
  local pids=$(start_cli_background_with_timeout "dist" 30 start --character examples/character.json)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  kill_timeout_processes "$pids"
}

# Test 7: File extension handling
@test "start: handles missing .ts extensions in built environment" {
  # This tests the issue where built CLI needs .js extensions
  create_test_character "test-char.json"
  
  # Create a plugin that might have import issues
  mkdir -p test-plugin/dist
  cat > test-plugin/package.json <<EOF
{
  "name": "test-import-plugin",
  "type": "module",
  "main": "./dist/index.js"
}
EOF
  
  cat > test-plugin/dist/index.js <<EOF
// This would fail in built environment without .js extension
import { someUtil } from './utils.js';
export default { name: 'test-import-plugin', actions: [] };
EOF
  
  cat > test-plugin/dist/utils.js <<EOF
export const someUtil = () => 'test';
EOF
  
  # Character using the plugin
  cat > test-char.json <<EOF
{
  "name": "ImportTest",
  "description": "Test import handling",
  "modelProvider": "openai",
  "plugins": ["./test-plugin"]
}
EOF
  
  local pids=$(start_cli_background_with_timeout "dist" 30 start --character test-char.json)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  kill_timeout_processes "$pids"
}

# Test 8: Environment variable handling
@test "start: respects .env file in different contexts" {
  create_test_project_with_agents "env-test"
  cd env-test
  
  # Add custom env variable
  echo "CUSTOM_TEST_VAR=test123" >> .env
  echo "SERVER_PORT=5555" >> .env
  
  local pids=$(start_cli_background_with_timeout "dist" 30 start)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  # Check if custom port is used
  wait_for_port 5555 5
  
  kill_timeout_processes "$pids"
}

# Test 9: Mixed TypeScript/JavaScript project
@test "start: handles mixed TS/JS project correctly" {
  mkdir -p mixed-project
  cd mixed-project
  
  # Create package.json
  cat > package.json <<EOF
{
  "name": "mixed-project",
  "type": "module",
  "scripts": {
    "start": "elizaos start"
  },
  "dependencies": {
    "@elizaos/core": "latest"
  }
}
EOF
  
  # Create character
  create_test_character "character.json"
  
  # Create mixed plugin (TS source, JS dist)
  mkdir -p plugin/src plugin/dist
  
  cat > plugin/src/index.ts <<EOF
import { Plugin } from '@elizaos/core';
export const mixedPlugin: Plugin = {
  name: 'mixed-plugin',
  actions: []
};
EOF
  
  cat > plugin/dist/index.js <<EOF
export const mixedPlugin = {
  name: 'mixed-plugin',
  actions: []
};
export default mixedPlugin;
EOF
  
  cat > plugin/package.json <<EOF
{
  "name": "mixed-plugin",
  "main": "./dist/index.js",
  "type": "module"
}
EOF
  
  # Update character to use plugin
  local char_content=$(cat character.json)
  echo "${char_content%?}, \"plugins\": [\"./plugin\"]}" > character.json
  
  local pids=$(start_cli_background_with_timeout "dist" 30 start --character character.json)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  kill_timeout_processes "$pids"
}

# Test 10: Database configuration in different environments
@test "start: database configuration works across environments" {
  create_test_project_with_agents "db-test"
  cd db-test
  
  # Test with PGLite (default)
  local pids=$(start_cli_background_with_timeout "dist" 30 start)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  # Check if PGLite directory was created
  [[ -d ".eliza/pglite" ]] || [[ -d "../.eliza/pglite" ]]
  
  kill_timeout_processes "$pids"
}

# Test 11: Multiple agents with different configurations
@test "start: handles multiple agents with different plugin configs" {
  create_test_character "agent1.json"
  create_test_character "agent2.json"
  
  # Create different plugins for each agent
  create_test_plugin "plugin1" "javascript"
  create_test_plugin "plugin2" "javascript"
  
  # Update characters with different plugins
  local char1=$(cat agent1.json)
  echo "${char1%?}, \"plugins\": [\"./plugin1\"]}" > agent1.json
  
  local char2=$(cat agent2.json)
  echo "${char2%?}, \"plugins\": [\"./plugin2\"]}" > agent2.json
  
  local pids=$(start_cli_background_with_timeout "dist" 30 start --character agent1.json agent2.json)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  kill_timeout_processes "$pids"
}

# Test 12: Path resolution across environments
@test "start: resolves paths correctly in different working directories" {
  # Create nested structure
  mkdir -p project/subdir
  create_test_character "project/character.json"
  
  # Test from different directories
  cd project/subdir
  
  # Should find character with relative path
  local pids=$(start_cli_background_with_timeout "dist" 30 start --character ../character.json)
  local server_pid=$(parse_timeout_pids "$pids")
  BACKGROUND_PIDS+=($pids)
  
  sleep 5
  
  assert_process_running $server_pid
  
  kill_timeout_processes "$pids"
} 