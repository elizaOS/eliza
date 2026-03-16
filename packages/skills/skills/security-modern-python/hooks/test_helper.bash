#!/usr/bin/env bash
# Test helper functions for intercept-legacy-python.sh BATS tests
# shellcheck disable=SC2154  # status/output are BATS-provided variables
# shellcheck disable=SC2016  # Single quotes for jq filter are intentional

# Path to the hook script under test
HOOK_SCRIPT="${BATS_TEST_DIRNAME}/intercept-legacy-python.sh"

# Run the hook with a bash command
# Usage: run_hook "python script.py"
# Uses jq to properly escape the command string for JSON
run_hook() {
  local cmd="$1"
  # Use jq to create properly escaped JSON, pipe directly to script
  run bash -c 'jq -n --arg cmd "$1" '"'"'{"tool_input":{"command":$cmd}}'"'"' | "$2"' _ "$cmd" "$HOOK_SCRIPT"
}

# Run hook without uv available (for testing early exit)
# Usage: run_hook_no_uv "python script.py"
run_hook_no_uv() {
  local cmd="$1"
  # Create a subshell with restricted PATH that excludes uv
  # Suppress stderr to ignore jq's "Broken pipe" when script exits early
  run env PATH=/usr/bin:/bin bash -c 'jq -n --arg cmd "$1" '"'"'{"tool_input":{"command":$cmd}}'"'"' 2>/dev/null | "$2"' _ "$cmd" "$HOOK_SCRIPT"
}

# Assert the hook allowed the command (exit 0, no output)
assert_allow() {
  if [[ $status -ne 0 ]]; then
    echo "Expected exit 0 (allow), got exit $status"
    echo "Output: $output"
    return 1
  fi
  if [[ -n "$output" ]]; then
    echo "Expected no output (allow), got:"
    echo "$output"
    return 1
  fi
}

# Assert the hook denied the command (JSON output with deny decision)
assert_deny() {
  if [[ $status -ne 0 ]]; then
    echo "Expected exit 0 with deny JSON, got exit $status"
    echo "Output: $output"
    return 1
  fi
  if [[ -z "$output" ]]; then
    echo "Expected deny JSON output, got empty"
    return 1
  fi
  if ! echo "$output" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1; then
    echo "Expected permissionDecision: deny"
    echo "Output: $output"
    return 1
  fi
}

# Assert the suggestion contains expected text
# Usage: assert_suggestion_contains "uv run python"
assert_suggestion_contains() {
  local expected="$1"
  local reason
  reason=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty' 2>/dev/null)
  if [[ -z "$reason" ]]; then
    echo "No permissionDecisionReason found in output"
    echo "Output: $output"
    return 1
  fi
  if [[ "$reason" != *"$expected"* ]]; then
    echo "Expected suggestion to contain: $expected"
    echo "Got: $reason"
    return 1
  fi
}
