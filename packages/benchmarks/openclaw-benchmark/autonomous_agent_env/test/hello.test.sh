#!/usr/bin/env bash

# ============================================
# BATS-Compatible Test Suite for hello.sh
# Tests the Hello Utility with comprehensive coverage
# ============================================

# If BATS is available, this file can be used with BATS
# Otherwise, run as standalone test suite
# Standalone execution - simple test runner
set -e

# Test counter - using local variables in test runner instead

# Helper functions for standalone mode
assert_equals() {
    local expected="$1"
    local actual="$2"
    local message="${3:-Assertion failed}"
    
    if [[ "$expected" != "$actual" ]]; then
        echo "❌ $message"
        echo "   Expected: '$expected'"
        echo "   Actual:   '$actual'"
        return 1
    fi
}

assert_success() {
    local exit_code="$1"
    if [[ "$exit_code" != "0" ]]; then
        echo "❌ Command failed with exit code $exit_code"
        return 1
    fi
}

assert_failure() {
    local exit_code="$1"
    if [[ "$exit_code" == "0" ]]; then
        echo "❌ Command should have failed but succeeded"
        return 1
    fi
}

run() {
    local command_string="$*"
    local temp_output
    local temp_exit_code
    temp_output=$(mktemp)
    temp_exit_code=$(mktemp)
    
    # Execute command string and capture output and exit code separately
    eval "$command_string" > "$temp_output" 2>&1; echo $? > "$temp_exit_code"
    
    # Set global variables for assertions
    output=$(cat "$temp_output")
    status=$(cat "$temp_exit_code")
    lines=()
    while IFS= read -r line; do
        lines+=("$line")
    done <<< "$output"
    
    # Clean up temp files
    rm -f "$temp_output" "$temp_exit_code"
}

echo "🧪 Running tests for hello.sh"
echo ""

# Helper function to get script path
get_script_path() {
    echo "$(dirname "$0")/../scripts/hello.sh"
}

HELLO_SCRIPT=$(get_script_path)

# ============================================
# Test Functions
# ============================================

test_default_hello_output() {
    echo "🧪 Testing: hello.sh outputs 'hello' by default"
    run "$HELLO_SCRIPT"
    assert_success "$status"
    assert_equals "hello" "$output"
}

test_custom_message_output() {
    echo "🧪 Testing: hello.sh outputs custom message when provided"
    run "$HELLO_SCRIPT world"
    assert_success "$status"
    assert_equals "world" "$output"
}

test_multi_word_message() {
    echo "🧪 Testing: hello.sh handles multi-word messages"
    run "$HELLO_SCRIPT \"test message\""
    assert_success "$status"
    assert_equals "test message" "$output"
}

test_special_characters() {
    echo "🧪 Testing: hello.sh handles messages with special characters"
    run "$HELLO_SCRIPT hello-world_123"
    assert_success "$status"
    assert_equals "hello-world_123" "$output"
}

test_help_flag_long() {
    echo "🧪 Testing: hello.sh shows help with --help flag"
    run "$HELLO_SCRIPT --help"
    assert_success "$status"
    
    # Check that help contains key information
    [[ "$output" =~ "Usage:" ]] || { echo "Missing Usage line"; return 1; }
    [[ "$output" =~ "message:" ]] || { echo "Missing message description"; return 1; }
    [[ "$output" =~ "Examples:" ]] || { echo "Missing Examples section"; return 1; }
}

test_help_flag_short() {
    echo "🧪 Testing: hello.sh shows help with -h flag"
    run "$HELLO_SCRIPT -h"
    assert_success "$status"
    
    # Check that help contains key information
    [[ "$output" =~ "Usage:" ]] || { echo "Missing Usage line"; return 1; }
    [[ "$output" =~ "message:" ]] || { echo "Missing message description"; return 1; }
}

test_help_in_argument() {
    echo "🧪 Testing: hello.sh shows help when --help is in argument"
    run "$HELLO_SCRIPT \"test --help message\""
    assert_success "$status"
    [[ "$output" =~ "Usage:" ]] || { echo "Missing Usage line"; return 1; }
}

test_empty_string_uses_default() {
    echo "🧪 Testing: hello.sh uses default for empty string argument"
    run "$HELLO_SCRIPT \"\""
    assert_success "$status"
    assert_equals "hello" "$output"
}

test_whitespace_rejection() {
    echo "🧪 Testing: hello.sh rejects whitespace-only argument"
    run "$HELLO_SCRIPT \"   \""
    assert_failure "$status"
    [[ "$output" =~ "Error: Message cannot be empty" ]] || { echo "Wrong error message"; return 1; }
}

test_tab_handling() {
    echo "🧪 Testing: hello.sh handles tab character"
    run "$HELLO_SCRIPT \$'\\t'"
    assert_success "$status"
    # Tab should be output as-is
    assert_equals $'\t' "$output"
}

test_mixed_whitespace_content() {
    echo "🧪 Testing: hello.sh handles mixed whitespace content"
    run "$HELLO_SCRIPT \"  hello world  \""
    assert_success "$status"
    assert_equals "  hello world  " "$output"
}

test_success_exit_code() {
    echo "🧪 Testing: hello.sh exits with code 0 on success"
    run "$HELLO_SCRIPT success"
    assert_success "$status"
}

test_error_exit_code() {
    echo "🧪 Testing: hello.sh exits with code 1 on whitespace input error"
    run "$HELLO_SCRIPT \"   \""
    assert_failure "$status"
    assert_equals "1" "$status"
}

test_script_executable() {
    echo "🧪 Testing: hello.sh script is executable"
    if [[ ! -x "$HELLO_SCRIPT" ]]; then
        echo "❌ Script is not executable"
        return 1
    fi
}

test_proper_shebang() {
    echo "🧪 Testing: hello.sh script has proper shebang"
    local first_line
    first_line=$(head -n1 "$HELLO_SCRIPT")
    assert_equals "#!/usr/bin/env bash" "$first_line" "Script should have bash shebang"
}

test_set_e_directive() {
    echo "🧪 Testing: hello.sh script uses set -e for error handling"
    local second_line
    second_line=$(sed -n '2p' "$HELLO_SCRIPT")
    [[ "$second_line" =~ "set -e" ]] || { echo "Missing 'set -e' directive"; return 1; }
}

# ============================================
# Test Runner
# ============================================

# Run all tests
test_count=0
passed_count=0

# List of test functions
test_functions=(
    "test_default_hello_output"
    "test_custom_message_output"
    "test_multi_word_message"
    "test_special_characters"
    "test_help_flag_long"
    "test_help_flag_short"
    "test_help_in_argument"
    "test_empty_string_uses_default"
    "test_whitespace_rejection"
    "test_tab_handling"
    "test_mixed_whitespace_content"
    "test_success_exit_code"
    "test_error_exit_code"
    "test_script_executable"
    "test_proper_shebang"
    "test_set_e_directive"
)

# Execute tests
for test_func in "${test_functions[@]}"; do
    test_count=$((test_count + 1))
    
    if $test_func; then
        echo "✅ Passed: $test_func"
        passed_count=$((passed_count + 1))
    else
        echo "❌ Failed: $test_func"
        echo ""
        echo "💥 Test suite failed!"
        echo "══════════════════════════════════════════════"
        echo "  🧪 Total:  $test_count"
        echo "  ✅ Passed: $passed_count"
        echo "  ❌ Failed: $((test_count - passed_count))"
        echo "══════════════════════════════════════════════"
        exit 1
    fi
    echo ""
done

echo "══════════════════════════════════════════════"
echo "  Test Results"
echo "══════════════════════════════════════════════"
echo "  🧪 Total:  $test_count"
echo "  ✅ Passed: $passed_count"
echo "  ❌ Failed: $((test_count - passed_count))"
echo "══════════════════════════════════════════════"

if [[ $passed_count -eq $test_count ]]; then
    echo "🎉 All tests passed!"
    exit 0
else
    echo "💥 Some tests failed!"
    exit 1
fi