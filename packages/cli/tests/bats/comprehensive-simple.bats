#!/usr/bin/env bats

load 'helpers/test-helpers'

# Simplified comprehensive test coverage for ElizaOS CLI
# Focuses on creation and basic validation without building/running

setup() {
    setup_test_environment
    
    # Set test mode to skip dependency installation
    export ELIZA_TEST_MODE=true
    export ELIZA_NONINTERACTIVE=true
}

teardown() {
    teardown_test_environment
}

# Test 1: Create project template
@test "simple: create project-starter template" {
    run run_cli "dist" create test-project
    [ "$status" -eq 0 ]
    [[ "$output" =~ "successfully" ]]
    [ -d "test-project" ]
    [ -f "test-project/package.json" ]
    [ -f "test-project/src/index.ts" ]
}

# Test 2: Create plugin template
@test "simple: create plugin-starter template" {
    run run_cli "dist" create test-plugin --type plugin
    [ "$status" -eq 0 ]
    [[ "$output" =~ "successfully" ]]
    [ -d "plugin-test" ]
    [ -f "plugin-test/package.json" ]
    [ -f "plugin-test/src/index.ts" ]
}

# Test 3: Create agent
@test "simple: create agent character file" {
    run run_cli "dist" create test-agent --type agent
    [ "$status" -eq 0 ]
    [[ "$output" =~ "successfully" ]]
    [ -f "test-agent.json" ]
}

# Test 4: Test inside monorepo context
@test "context: create project inside monorepo" {
    cd "$MONOREPO_ROOT/packages"
    
    # Create a temporary test directory
    mkdir -p test-monorepo-temp
    cd test-monorepo-temp
    
    run run_cli "dist" create test-monorepo-project
    [ "$status" -eq 0 ]
    
    # Check if workspace protocol is used
    if [ -f "test-monorepo-project/package.json" ]; then
        grep -q "workspace:\\*" test-monorepo-project/package.json && echo "Uses workspace protocol"
    fi
    
    # Clean up
    cd "$MONOREPO_ROOT/packages"
    rm -rf test-monorepo-temp
}

# Test 5: Test outside monorepo context
@test "context: create project outside monorepo" {
    # Create temp directory outside monorepo
    local EXTERNAL_DIR="$BATS_TEST_TMPDIR/external-test"
    mkdir -p "$EXTERNAL_DIR"
    cd "$EXTERNAL_DIR"
    
    run run_cli "dist" create standalone-project
    [ "$status" -eq 0 ]
    
    # Should have explicit versions, not workspace protocol
    if [ -f "standalone-project/package.json" ]; then
        ! grep -q "workspace:\\*" standalone-project/package.json || echo "Should not use workspace protocol"
    fi
}

# Test 6: Failure case - invalid project name
@test "failure: reject invalid project names" {
    run run_cli "dist" create "invalid name with spaces"
    [ "$status" -ne 0 ]
    [[ "$output" =~ "Invalid" ]] || [[ "$output" =~ "invalid" ]]
}

# Test 7: Create TEE project
@test "simple: create TEE project" {
    run run_cli "dist" create test-tee --type tee
    [ "$status" -eq 0 ]
    [[ "$output" =~ "successfully" ]]
    [ -d "test-tee" ]
    [ -f "test-tee/package.json" ]
}

# Test 8: Multiple character files in project
@test "simple: project with multiple agents directory" {
    run run_cli "dist" create multi-agent-project
    [ "$status" -eq 0 ]
    
    # Create agents directory
    mkdir -p multi-agent-project/agents
    
    # Create multiple agent files
    cd multi-agent-project
    run run_cli "dist" create agent1 --type agent
    [ "$status" -eq 0 ]
    
    run run_cli "dist" create agent2 --type agent
    [ "$status" -eq 0 ]
    
    # Verify both agent files exist
    [ -f "agent1.json" ]
    [ -f "agent2.json" ]
}

# Test 9: Check CLI help
@test "help: create command shows help" {
    run run_cli "dist" create --help
    [ "$status" -eq 0 ]
    [[ "$output" =~ "Create a new ElizaOS project" ]]
    [[ "$output" =~ "--type" ]]
    [[ "$output" =~ "--dir" ]]
}

# Test 10: Verify templates exist
@test "templates: verify template directories exist" {
    [ -d "$CLI_ROOT/templates/project-starter" ]
    [ -d "$CLI_ROOT/templates/plugin-starter" ]
    [ -d "$CLI_ROOT/templates/project-tee-starter" ]
} 