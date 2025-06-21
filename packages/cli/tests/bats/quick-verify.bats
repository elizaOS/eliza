#!/usr/bin/env bats

load 'helpers/test-helpers'
load 'helpers/environment-helpers'

# Quick verification test for comprehensive coverage setup

setup() {
    setup_test_environment
    
}

teardown() {
    teardown_test_environment
}

@test "verify: CLI binary exists" {
    [ -f "$CLI_ROOT/dist/index.js" ]
}

@test "verify: can create a simple project" {
    # Set non-interactive mode and test mode to skip installation
    export ELIZA_NONINTERACTIVE=true
    export ELIZA_TEST_MODE=true
    
    run run_cli "dist" create test-project
    [ "$status" -eq 0 ]
    [[ "$output" =~ "successfully" ]]
    [ -d "test-project" ]
}

@test "verify: can create a plugin" {
    # Set non-interactive mode and test mode to skip installation
    export ELIZA_NONINTERACTIVE=true
    export ELIZA_TEST_MODE=true
    
    run run_cli "dist" create test-plugin --type plugin
    [ "$status" -eq 0 ]
    [[ "$output" =~ "successfully" ]]
    # Plugin name is shortened to 'plugin-test' not 'plugin-test-plugin'
    [ -d "plugin-test" ]
} 