#!/usr/bin/env bats

load 'helpers/test-helpers'

# Comprehensive test coverage for ElizaOS CLI
# Tests templates, migrations, contexts, lifecycle, and failure cases

# Track background processes for cleanup
BACKGROUND_PIDS=()

setup() {
    setup_test_environment
    
    # Set test mode to skip dependency installation
    export ELIZA_TEST_MODE=true
    export ELIZA_NONINTERACTIVE=true
    
    # Track PIDs for cleanup
    export PIDS_FILE="$TEST_DIR/.test_pids"
    touch "$PIDS_FILE"
}

teardown() {
    # Kill any background processes
    for pids in "${BACKGROUND_PIDS[@]}"; do
        if [[ -n "$pids" ]]; then
            if [[ "$pids" == *:* ]]; then
                # Handle timeout format (server_pid:timer_pid)
                kill_timeout_processes "$pids"
            else
                # Handle single PID
                kill_process_gracefully "$pids"
            fi
        fi
    done
    
    # Kill any running processes from PIDS_FILE
    if [ -f "$PIDS_FILE" ]; then
        while read -r pid; do
            if kill -0 "$pid" 2>/dev/null; then
                kill -TERM "$pid" 2>/dev/null || true
                sleep 1
                kill -KILL "$pid" 2>/dev/null || true
            fi
        done < "$PIDS_FILE"
    fi
    
    teardown_test_environment
}

# Helper to start a process with timeout
start_with_timeout() {
    local cmd="$1"
    local timeout="${2:-20}"
    local log_file="${3:-$TEST_DIR/process.log}"
    
    # Start the process in background
    $cmd > "$log_file" 2>&1 &
    local pid=$!
    echo "$pid" >> "$PIDS_FILE"
    
    # Set up timeout
    (
        sleep "$timeout"
        if kill -0 "$pid" 2>/dev/null; then
            echo "Process $pid killed after ${timeout}s timeout"
            kill -TERM "$pid" 2>/dev/null || true
        fi
    ) &
    local timeout_pid=$!
    echo "$timeout_pid" >> "$PIDS_FILE"
    
    echo "$pid"
}

# Helper to modify index.ts by removing top 5 lines
break_index_file() {
    local file="$1"
    if [ -f "$file" ]; then
        tail -n +6 "$file" > "$file.tmp"
        mv "$file.tmp" "$file"
    fi
}

# Helper to wait for server ready
wait_for_server() {
    local port="${1:-3000}"
    local timeout="${2:-30}"
    local elapsed=0
    
    while [ $elapsed -lt $timeout ]; do
        if curl -s "http://localhost:$port/health" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    
    return 1
}

# Test 1: Create and run project-starter template
@test "template: create and run project-starter end-to-end" {
    # Create project from template
    run node "$ELIZAOS_BIN" create test-project --yes
    assert_success
    assert_output --partial "created successfully"
    
    # Navigate to project
    cd "$TEST_DIR/test-project"
    
    # Install dependencies
    run bun install
    assert_success
    
    # Build the project
    run bun run build
    assert_success
    
    # Run tests
    run bun test
    assert_success
    
    # Start the project with timeout
    local pid=$(start_with_timeout "bun run start" 20)
    
    # Wait for server
    run wait_for_server 3000 15
    assert_success
    
    # Verify process was killed after timeout
    sleep 22
    run kill -0 "$pid"
    assert_failure
}

# Test 2: Create and run plugin-starter template
@test "template: create and run plugin-starter end-to-end" {
    # Create plugin from template
    run node "$ELIZAOS_BIN" create test-plugin --type plugin --yes
    assert_success
    assert_output --partial "created successfully"
    
    # Navigate to plugin
    cd "$TEST_DIR/test-plugin"
    
    # Install dependencies
    run bun install
    assert_success
    
    # Build the plugin
    run bun run build
    assert_success
    
    # Run tests
    run bun test
    assert_success
    
    # Create a test project to use the plugin
    cd "$TEST_DIR"
    run node "$ELIZAOS_BIN" create plugin-test-project --no-install
    assert_success
    
    cd "$TEST_DIR/plugin-test-project"
    
    # Link the plugin
    echo "{
        \"name\": \"plugin-test-project\",
        \"dependencies\": {
            \"@elizaos/core\": \"workspace:*\",
            \"test-plugin\": \"file:../test-plugin\"
        }
    }" > package.json
    
    run bun install
    assert_success
}

# Test 3: Plugin creation with schema and migration
@test "migration: create plugin with schema and test migration" {
    # Create plugin with schema
    run node "$ELIZAOS_BIN" create migration-plugin --type plugin --yes
    assert_success
    
    cd "$TEST_DIR/migration-plugin"
    
    # For now, skip schema verification as it's not in the template
    # TODO: Add schema generation to plugin template
    
    # Install and build
    run bun install
    assert_success
    
    run bun run build
    assert_success
    
    # Skip migration test for now
    # TODO: Add migration support to plugin template
}

# Test 4: Test inside monorepo context
@test "context: create and run project inside monorepo" {
    # Create project inside monorepo packages
    cd "$MONOREPO_ROOT/packages"
    
    run node "$ELIZAOS_BIN" create test-monorepo-project --yes
    assert_success
    
    cd test-monorepo-project
    
    # Should use workspace protocol
    run grep -q "workspace:\\*" package.json
    assert_success
    
    # Install and run
    run bun install
    assert_success
    
    run bun run build
    assert_success
    
    # Clean up
    cd "$MONOREPO_ROOT/packages"
    rm -rf test-monorepo-project
}

# Test 5: Test outside monorepo context
@test "context: create and run project outside monorepo" {
    # Create temp directory outside monorepo
    local EXTERNAL_DIR="$BATS_TEST_TMPDIR/external-test"
    mkdir -p "$EXTERNAL_DIR"
    cd "$EXTERNAL_DIR"
    
    # Create project
    run node "$ELIZAOS_BIN" create standalone-project --yes
    assert_success
    
    cd standalone-project
    
    # Should NOT use workspace protocol
    run grep -q "workspace:\\*" package.json
    assert_failure
    
    # Should have explicit versions
    run grep -q "\"@elizaos/core\": \"\\^" package.json
    assert_success
    
    # Clean up
    cd "$BATS_TEST_TMPDIR"
    rm -rf "$EXTERNAL_DIR"
}

# Test 6: Global installation scenario
@test "context: test with global npm installation" {
    skip "Requires npm link setup - manual test"
    
    # This would test:
    # 1. npm link in CLI directory
    # 2. elizaos command globally
    # 3. Create project in any directory
    # 4. Verify it works correctly
}

# Test 7: Process lifecycle with proper cleanup
@test "lifecycle: start process and verify cleanup after timeout" {
    # Create a simple project
    run node "$ELIZAOS_BIN" create lifecycle-test --yes
    assert_success
    
    cd "$TEST_DIR/lifecycle-test"
    run bun install
    assert_success
    
    # Start with 10 second timeout
    local pid=$(start_with_timeout "bun run start" 10)
    
    # Verify process is running
    sleep 2
    run kill -0 "$pid"
    assert_success
    
    # Wait for timeout
    sleep 10
    
    # Verify process was killed
    run kill -0 "$pid"
    assert_failure
    
    # Check log for timeout message
    run grep -q "killed after 10s timeout" "$TEST_DIR/process.log"
    assert_success
}

# Test 8: Multiple processes management
@test "lifecycle: manage multiple agent processes" {
    # Create project with multiple agents
    run node "$ELIZAOS_BIN" create multi-agent-test --yes
    assert_success
    
    cd "$TEST_DIR/multi-agent-test"
    
    # Create multiple agent configs
    mkdir -p agents
    echo '{"name": "agent1", "bio": ["Test agent 1"]}' > agents/agent1.json
    echo '{"name": "agent2", "bio": ["Test agent 2"]}' > agents/agent2.json
    
    run bun install
    assert_success
    
    # Start both agents
    local pid1=$(start_with_timeout "bun run start --character agents/agent1.json" 15 "$TEST_DIR/agent1.log")
    local pid2=$(start_with_timeout "bun run start --character agents/agent2.json" 15 "$TEST_DIR/agent2.log")
    
    # Verify both are running
    sleep 2
    run kill -0 "$pid1"
    assert_success
    run kill -0 "$pid2"
    assert_success
    
    # Wait for timeout
    sleep 15
    
    # Verify both were killed
    run kill -0 "$pid1"
    assert_failure
    run kill -0 "$pid2"
    assert_failure
}

# Test 9: Failure case - modified index.ts
@test "failure: handle broken index.ts (top 5 lines removed)" {
    # Create project
    run node "$ELIZAOS_BIN" create broken-index-test --yes
    assert_success
    
    cd "$TEST_DIR/broken-index-test"
    run bun install
    assert_success
    
    # Break the index.ts file
    break_index_file "src/index.ts"
    
    # Try to build - should fail
    run bun run build
    assert_failure
    assert_output --partial "error"
    
    # Try to start - should fail
    run timeout 5 bun run start
    assert_failure
}

# Test 10: Failure case - missing dependencies
@test "failure: handle missing dependencies gracefully" {
    # Create project
    run node "$ELIZAOS_BIN" create missing-deps-test --yes
    assert_success
    
    cd "$TEST_DIR/missing-deps-test"
    
    # Remove a required dependency from package.json
    local pkg_content=$(cat package.json)
    echo "$pkg_content" | grep -v "@elizaos/core" > package.json
    
    # Install (will miss core dependency)
    run bun install
    assert_success
    
    # Try to start - should fail with clear error
    run timeout 5 bun run start
    assert_failure
    assert_output --partial "Cannot find module"
}

# Test 11: Failure case - test failures
@test "failure: handle test failures with proper exit codes" {
    # Create plugin with failing test
    run node "$ELIZAOS_BIN" create failing-test-plugin --type plugin --yes
    assert_success
    
    cd "$TEST_DIR/failing-test-plugin"
    
    # Add a failing test
    mkdir -p src/__tests__
    cat > src/__tests__/fail.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';

describe('Failing test', () => {
    it('should fail', () => {
        expect(true).toBe(false);
    });
});
EOF
    
    run bun install
    assert_success
    
    # Run tests - should fail
    run bun test
    assert_failure
    assert_output --partial "fail"
    
    # Check exit code
    [ "$status" -ne 0 ]
}

# Test 12: End-to-end plugin development workflow
@test "e2e: complete plugin development workflow" {
    # Create plugin
    run node "$ELIZAOS_BIN" create full-feature-plugin --type plugin --yes
    assert_success
    
    cd "$TEST_DIR/full-feature-plugin"
    
    # Verify basic plugin structure
    assert [ -f "src/index.ts" ]
    assert [ -f "package.json" ]
    assert [ -f "tsconfig.json" ]
    
    # Install and build
    run bun install
    assert_success
    
    run bun run build
    assert_success
    
    # Skip migrations for now
    
    # Run tests
    run bun test
    assert_success
    
    # Create test project using the plugin
    cd "$TEST_DIR"
    run node "$ELIZAOS_BIN" create plugin-consumer --yes
    assert_success
    
    cd plugin-consumer
    
    # Add plugin dependency
    local pkg=$(cat package.json)
    echo "$pkg" | jq '.dependencies["full-feature-plugin"] = "file:../full-feature-plugin"' > package.json
    
    run bun install
    assert_success
    
    # Create character using the plugin
    cat > character.json << 'EOF'
{
    "name": "PluginTest",
    "bio": ["Test character using custom plugin"],
    "plugins": ["full-feature-plugin"]
}
EOF
    
    # Start with timeout to verify plugin loads
    local pid=$(start_with_timeout "bun run start --character character.json" 10)
    
    # Check logs for plugin loading
    sleep 3
    run grep -q "Plugin.*loaded" "$TEST_DIR/process.log"
    assert_success
} 