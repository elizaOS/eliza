#!/usr/bin/env bats

setup() {
  set -euo pipefail
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-update-XXXXXX)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run $(cd "$BATS_TEST_DIRNAME/../dist" && pwd)/index.js}"
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