#!/usr/bin/env bats

setup() {
  set -euo pipefail
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-update-XXXXXX)"
  # Source common utilities
  source "$BATS_TEST_DIRNAME/common.sh"
  setup_elizaos_cmd
  cd "$TEST_TMP_DIR"
}

teardown() {
  [[ -n "${TEST_TMP_DIR:-}" && "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]] && rm -rf "$TEST_TMP_DIR"
}

# ──────────────────────────────────────────────────────────────────────────────
# --help
# ──────────────────────────────────────────────────────────────────────────────
@test "update --help shows usage and options" {
  run $ELIZAOS_CMD update --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos update"* ]]
  for opt in --cli --packages --check --skip-build; do
    [[ "$output" == *"$opt"* ]]
  done
}

# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────
make_proj() {            # $1 = directory name
  run $ELIZAOS_CMD create "$1" --yes
  [ "$status" -eq 0 ]
  cd "$1"
}

# ──────────────────────────────────────────────────────────────────────────────
# Basic runs
# ──────────────────────────────────────────────────────────────────────────────
@test "update runs in a valid project" {
  make_proj update-app
  run $ELIZAOS_CMD update
  [ "$status" -eq 0 ] || [[ "$output" == *"already up to date"* ]]
}

@test "update --check works" {
  make_proj update-check-app
  run $ELIZAOS_CMD update --check
  [ "$status" -eq 0 ]
  [[ "$output" =~ "Version: 1.0" ]]
}

@test "update --skip-build works" {
  make_proj update-skip-build-app
  run $ELIZAOS_CMD update --skip-build
  [ "$status" -eq 0 ]
  [[ "$output" != *"Building project"* ]]
}

@test "update --packages works" {
  make_proj update-packages-app
  run $ELIZAOS_CMD update --packages
  [ "$status" -eq 0 ] || [[ "$output" == *"already up to date"* ]]
}

@test "update --cli works outside a project" {
  run $ELIZAOS_CMD update --cli
  [ "$status" -eq 0 ]
}

@test "update --cli --packages works" {
  make_proj update-combined-app
  run $ELIZAOS_CMD update --cli --packages
  [ "$status" -eq 0 ] || [[ "$output" == *"already up to date"* ]]
}

@test "update succeeds outside a project (global check)" {
  run $ELIZAOS_CMD update
  [ "$status" -eq 0 ]
}

# ──────────────────────────────────────────────────────────────────────────────
# Non-project directory handling
# ──────────────────────────────────────────────────────────────────────────────
@test "update --packages shows helpful message in empty directory" {
  run $ELIZAOS_CMD update --packages
  [ "$status" -eq 0 ]
  [[ "$output" == *"No package.json found"* ]]
}

@test "update --packages shows helpful message in non-elizaos project" {
  # Create a non-ElizaOS package.json
  cat > package.json << EOF
{
  "name": "some-other-project",
  "version": "1.0.0",
  "dependencies": {
    "express": "^4.18.0"
  }
}
EOF
  
  run $ELIZAOS_CMD update --packages
  [ "$status" -eq 0 ]
  [[ "$output" == *"some-other-project"* ]]
  [[ "$output" == *"elizaos create"* ]]
}

@test "update --packages works in elizaos project with dependencies" {
  make_proj update-elizaos-project
  
  # Add some ElizaOS dependencies to make it a valid project
  cat > package.json << EOF
{
  "name": "test-elizaos-project",
  "version": "1.0.0",
  "dependencies": {
    "@elizaos/core": "^1.0.0"
  }
}
EOF
  
  run $ELIZAOS_CMD update --packages --check
  [ "$status" -eq 0 ]
  [[ "$output" == *"ElizaOS"* ]]
}

@test "update --packages shows message for project without elizaos dependencies" {
  make_proj update-no-deps-project
  
  # Create package.json without ElizaOS dependencies
  cat > package.json << EOF
{
  "name": "test-project",
  "version": "1.0.0",
  "eliza": {
    "type": "project"
  },
  "dependencies": {
    "express": "^4.18.0"
  }
}
EOF
  
  run $ELIZAOS_CMD update --packages
  [ "$status" -eq 0 ]
  [[ "$output" == *"doesn't appear to be an ElizaOS project"* ]]
}