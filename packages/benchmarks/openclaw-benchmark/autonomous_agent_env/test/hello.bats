#!/usr/bin/env bats

# ============================================
# BATS Test Suite for hello.sh
# Tests the Hello Utility with comprehensive coverage
# ============================================

load test_helper

HELLO_SCRIPT="$(dirname "$BATS_TEST_DIRNAME")/scripts/hello.sh"

@test "hello.sh outputs 'hello' by default" {
    run "$HELLO_SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" = "hello" ]
}

@test "hello.sh outputs custom message when provided" {
    run "$HELLO_SCRIPT" "world"
    [ "$status" -eq 0 ]
    [ "$output" = "world" ]
}

@test "hello.sh handles multi-word messages" {
    run "$HELLO_SCRIPT" "test message"
    [ "$status" -eq 0 ]
    [ "$output" = "test message" ]
}

@test "hello.sh handles messages with special characters" {
    run "$HELLO_SCRIPT" "hello-world_123"
    [ "$status" -eq 0 ]
    [ "$output" = "hello-world_123" ]
}

@test "hello.sh shows help with --help flag" {
    run "$HELLO_SCRIPT" "--help"
    [ "$status" -eq 0 ]
    [[ "$output" =~ "Usage:" ]]
    [[ "$output" =~ "message:" ]]
    [[ "$output" =~ "Examples:" ]]
}

@test "hello.sh shows help with -h flag" {
    run "$HELLO_SCRIPT" "-h"
    [ "$status" -eq 0 ]
    [[ "$output" =~ "Usage:" ]]
    [[ "$output" =~ "message:" ]]
}

@test "hello.sh shows help when --help is in argument" {
    run "$HELLO_SCRIPT" "test --help message"
    [ "$status" -eq 0 ]
    [[ "$output" =~ "Usage:" ]]
}

@test "hello.sh uses default for empty string argument" {
    run "$HELLO_SCRIPT" ""
    [ "$status" -eq 0 ]
    [ "$output" = "hello" ]
}

@test "hello.sh rejects whitespace-only argument" {
    run "$HELLO_SCRIPT" "   "
    [ "$status" -eq 1 ]
    [[ "$output" =~ "Error: Message cannot be empty" ]]
}

@test "hello.sh handles tab character" {
    run "$HELLO_SCRIPT" $'\t'
    [ "$status" -eq 0 ]
    [ "$output" = $'\t' ]
}

@test "hello.sh handles mixed whitespace content" {
    run "$HELLO_SCRIPT" "  hello world  "
    [ "$status" -eq 0 ]
    [ "$output" = "  hello world  " ]
}

@test "hello.sh exits with code 0 on success" {
    run "$HELLO_SCRIPT" "success"
    [ "$status" -eq 0 ]
}

@test "hello.sh exits with code 1 on whitespace input error" {
    run "$HELLO_SCRIPT" "   "
    [ "$status" -eq 1 ]
}

@test "hello.sh script is executable" {
    [ -x "$HELLO_SCRIPT" ]
}

@test "hello.sh script has proper shebang" {
    local first_line
    first_line=$(head -n1 "$HELLO_SCRIPT")
    [ "$first_line" = "#!/usr/bin/env bash" ]
}

@test "hello.sh script uses set -e for error handling" {
    local second_line
    second_line=$(sed -n '2p' "$HELLO_SCRIPT")
    [[ "$second_line" =~ "set -e" ]]
}