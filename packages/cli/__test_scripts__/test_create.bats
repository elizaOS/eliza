#!/usr/bin/env bats

# -----------------------------------------------------------------------------
# End‑to‑end tests for the ElizaOS CLI and the create‑eliza helper.
# These tests intentionally live in a throw‑away tmp dir so that each run is
# hermetic and leaves no traces on the host file‑system.
# -----------------------------------------------------------------------------

setup() {
  # Fail fast inside helper functions and loops.
  set -euo pipefail

  # One top‑level tmp dir per test run.
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-XXXXXX)"

  # Resolve the two CLI entry points we exercise in this suite.
  export ELIZAOS_CMD="bun run $(pwd)/dist/index.js"
  export CREATE_ELIZA_CMD="${CREATE_ELIZA_CMD:-bun run $(cd "$BATS_TEST_DIRNAME/../../create-eliza" && pwd)/index.mjs}"

  cd "$TEST_TMP_DIR"

  # Soft warning when jq is absent – JSON checks will fall back to grep.
  if ! command -v jq &> /dev/null; then
    echo "Warning: jq is not installed. JSON validation will be limited." >&2
  fi
}

teardown() {
  if [[ -n "${TEST_TMP_DIR:-}" && "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]]; then
    rm -rf "$TEST_TMP_DIR"
  fi
}

# -----------------------------------------------------------------------------
# Helper: Validate the structure of an agent JSON file.
# -----------------------------------------------------------------------------
validate_agent_json() {
  local json_file="$1" expected_name="$2"

  if command -v jq &> /dev/null; then
    run jq -e --arg n "$expected_name" '
        .name == $n                          and
        (.system           | type == "string" and length > 0) and
        (.bio              | type == "string" and length > 0) and
        (.messageExamples  | type == "array"  and length > 0)
      ' "$json_file"
    [ "$status" -eq 0 ]
  else
    run cat "$json_file"
    [ "$status" -eq 0 ]
    [[ "$output" == *"\"name\": \"$expected_name\""* ]]
    [[ "$output" == *"\"system\":"* ]]
    [[ "$output" == *"\"bio\":"* ]]
    [[ "$output" == *"\"messageExamples\":"* ]]
  fi
}

# -----------------------------------------------------------------------------
# create --help
# -----------------------------------------------------------------------------
@test "create --help shows usage" {
  run $ELIZAOS_CMD create --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos create"* ]]
  [[ "$output" =~ (project|plugin|agent) ]]
  [[ "$output" != *"frobnicate"* ]]
}

# -----------------------------------------------------------------------------
# Project scaffolding (default)
# -----------------------------------------------------------------------------
@test "create default project succeeds" {
  rm -rf my-default-app
  run $ELIZAOS_CMD create my-default-app --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Project initialized successfully!"* ]]
  [ -d "my-default-app" ]
  [ -f "my-default-app/package.json" ]
  [ -d "my-default-app/src" ]
  [ -d "my-default-app/knowledge" ]
  [ -f "my-default-app/.gitignore" ]
  [ -f "my-default-app/.npmignore" ]
}

# -----------------------------------------------------------------------------
# Plugin scaffolding
# -----------------------------------------------------------------------------
@test "create plugin project succeeds" {
  rm -rf plugin-my-plugin-app
  run $ELIZAOS_CMD create my-plugin-app --yes --type plugin
  [ "$status" -eq 0 ]
  [[ "$output" == *"Plugin initialized successfully!"* ]]
  local plugin_dir="plugin-my-plugin-app"
  [ -d "$plugin_dir" ]
  [ -f "$plugin_dir/package.json" ]
  [ -f "$plugin_dir/src/index.ts" ]
}

# -----------------------------------------------------------------------------
# Agent scaffolding
# -----------------------------------------------------------------------------
@test "create agent succeeds" {
  rm -f my-test-agent.json
  run $ELIZAOS_CMD create my-test-agent --yes --type agent
  [ "$status" -eq 0 ]
  [[ "$output" == *"Agent character created successfully"* ]]
  [ -f "my-test-agent.json" ]
  validate_agent_json "my-test-agent.json" "my-test-agent"
}

# -----------------------------------------------------------------------------
# Reject creating inside an existing directory
# -----------------------------------------------------------------------------
@test "rejects creating project in existing directory (expected failure or warning)" {
  rm -rf existing-app
  mkdir existing-app
  run $ELIZAOS_CMD create existing-app --yes
  if [ "$status" -eq 0 ]; then
    [[ "$output" == *"already exists"* ]]
  else
    [ "$status" -ne 0 ]
  fi
}

# -----------------------------------------------------------------------------
# In‑place scaffolding
# -----------------------------------------------------------------------------
@test "create project in current directory" {
  rm -rf create-in-place
  mkdir create-in-place && cd create-in-place
  run $ELIZAOS_CMD create . --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Project initialized successfully!"* ]]
  [ -f "package.json" ]
}

# -----------------------------------------------------------------------------
# Invalid inputs
# -----------------------------------------------------------------------------
@test "rejects invalid project name" {
  run $ELIZAOS_CMD create "Invalid Name" --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"Invalid"* ]] || [[ "${error:-}" == *"Invalid"* ]]
}

@test "rejects invalid project type" {
  run $ELIZAOS_CMD create bad-type-proj --yes --type bad-type
  [ "$status" -ne 0 ]
  [[ "$output" == *"Invalid type"* ]] || [[ "${error:-}" == *"Invalid type"* ]]
}

# -----------------------------------------------------------------------------
# create‑eliza parity tests
# -----------------------------------------------------------------------------
@test "create-eliza default project succeeds" {
  rm -rf my-create-app
  run $CREATE_ELIZA_CMD my-create-app --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Project initialized successfully!"* ]]
  [ -d "my-create-app" ]
  [ -f "my-create-app/package.json" ]
  [ -d "my-create-app/src" ]
}

@test "create-eliza plugin project succeeds" {
  rm -rf plugin-my-create-plugin
  run $CREATE_ELIZA_CMD my-create-plugin --yes --type plugin
  [ "$status" -eq 0 ]
  [[ "$output" == *"Plugin initialized successfully!"* ]]
  local plugin_dir="plugin-my-create-plugin"
  [ -d "$plugin_dir" ]
  [ -f "$plugin_dir/package.json" ]
  [ -f "$plugin_dir/src/index.ts" ]
}

@test "create-eliza agent succeeds" {
  rm -f my-create-agent.json
  run $CREATE_ELIZA_CMD my-create-agent --yes --type agent
  [ "$status" -eq 0 ]
  [[ "$output" == *"Agent character created successfully"* ]]
  [ -f "my-create-agent.json" ]
  validate_agent_json "my-create-agent.json" "my-create-agent"
}
