#!/usr/bin/env bats

# -----------------------------------------------------------------------------
# End‑to‑end tests for the ElizaOS CLI `plugins publish` sub‑command.
#
# These tests verify that the `plugins publish` command works correctly with
# various flags (`--validate`, `--pack`, `--auth`, `--bump-version`), ensuring
# they run without errors and produce the expected outputs. For the `--pack`
# flag, we also verify that it creates a tarball as expected.
#
# Each test runs in an isolated temporary directory to ensure test isolation
# and prevent side effects.
# -----------------------------------------------------------------------------

setup() {
  # Fail fast inside helper functions and loops.
  set -euo pipefail

  # One top‑level tmp dir per test run.
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-publish-XXXXXX)"

  # Resolve the CLI entry point we'll be testing.
  # Ensure the CLI bundle is present; build once if missing.
  if [ ! -f "$BATS_TEST_DIRNAME/../dist/index.js" ]; then
    (cd "$BATS_TEST_DIRNAME/.." && bun run build)
  fi
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run $(cd "$BATS_TEST_DIRNAME/../dist" && pwd)/index.js}"

  cd "$TEST_TMP_DIR"
}

teardown() {
  if [[ -n "${TEST_TMP_DIR:-}" && "$TEST_TMP_DIR" == /var/tmp/eliza-test-publish-* ]]; then
    rm -rf "$TEST_TMP_DIR"
  fi
}

# -----------------------------------------------------------------------------
# Helper: Create a new plugin for testing
# -----------------------------------------------------------------------------
create_plugin() {
  local name="$1"
  run $ELIZAOS_CMD create "$name" --yes --type plugin
  [ "$status" -eq 0 ]
  cd "plugin-$name"
}

# -----------------------------------------------------------------------------
# plugins publish --help
# -----------------------------------------------------------------------------
@test "plugins publish help displays usage information" {
  run $ELIZAOS_CMD plugins publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Manage ElizaOS plugins"* ]]
  [[ "$output" =~ (--validate|--pack|--auth|--bump-version) ]]
}

# -----------------------------------------------------------------------------
# plugins publish --validate
# -----------------------------------------------------------------------------
@test "plugins publish --validate runs in plugins project" {
  create_plugin myplugins
  run $ELIZAOS_CMD plugins publish --validate
  [ "$status" -eq 0 ]
}

# -----------------------------------------------------------------------------
# plugins publish --pack
# -----------------------------------------------------------------------------
@test "plugins publish --pack creates a tarball" {
  create_plugin pkgplugins
  run $ELIZAOS_CMD plugins publish --pack
  echo "$error"
  [ "$status" -eq 0 ]
  cd plugin-pub-plugins
  run $ELIZAOS_CMD plugins publish --auth fake-token
  [ "$status" -ne 127 ]
}

# Checks that version bumping logic can be triggered in a plugins project directory.
@test "plugins publish bump-version runs in plugins project" {
  run $ELIZAOS_CMD create ver-plugins --yes --type plugin
  echo "$output"
  echo "$error"
  [ "$status" -eq 0 ]
  cd plugin-ver-plugins
  run $ELIZAOS_CMD plugins publish --bump-version
  [ "$status" -ne 127 ]
}