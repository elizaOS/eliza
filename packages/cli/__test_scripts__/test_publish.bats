#!/usr/bin/env bats

# -----------------------------------------------------------------------------
# publish tests: test the publish command's functionality
# These tests verify the command is properly wired and doesn't error out
# with "command not found" (127) or similar.
# -----------------------------------------------------------------------------

setup() {
  set -euo pipefail
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-plugins-XXXXXX)"
  cd "$TEST_TMP_DIR"

  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run $(cd "$BATS_TEST_DIRNAME/../dist" && pwd)/index.js}"
}

teardown() {
  [[ -n "${TEST_TMP_DIR:-}" && "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]] && rm -rf "$TEST_TMP_DIR"
}

# -----------------------------------------------------------------------------
# --help sanity
# -----------------------------------------------------------------------------
@test "publish help displays usage information" {
  run $ELIZAOS_CMD publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Publish a plugin or project to the registry"* ]]
  [[ "$output" =~ (--npm|--test|--dry-run|--skip-registry) ]]
}

# -----------------------------------------------------------------------------
# Test publish command with different options in a plugin workspace
# -----------------------------------------------------------------------------
create_plugin() {
  local name="$1"
  run $ELIZAOS_CMD create "$name" --yes --type plugin
  [ "$status" -eq 0 ]
  cd "plugin-$name"
  
  # Initialize a git repo since the publish command might need it
  git init -q
  git config user.email "test@example.com"
  git config user.name "Test User"
  git add .
  git commit -q -m "Initial commit"
}

@test "publish --test runs validation in plugin project" {
  create_plugin testplugin
  run $ELIZAOS_CMD publish --test
  [ "$status" -eq 0 ]
  [[ "$output" == *"Test publish process"* || "$output" == *"dry run"* ]]
}

@test "publish --dry-run generates files locally" {
  create_plugin dryrunplugin
  run $ELIZAOS_CMD publish --dry-run
  [ "$status" -eq 0 ]
  
  # Verify some expected output
  [[ "$output" == *"dry run"* || "$output" == *"would publish"* ]]
}

@test "publish with npm flag attempts npm publish" {
  create_plugin npmplugin
  
  # Mock npm whoami to succeed
  export PATH="$BATS_TEST_TMPDIR:$PATH"
  cat > "$BATS_TEST_TMPDIR/npm" <<'EOF'
#!/bin/bash
if [[ "$1" == "whoami" ]]; then
  echo "testuser"
  exit 0
fi
exit 1
EOF
  chmod +x "$BATS_TEST_TMPDIR/npm"
  
  run $ELIZAOS_CMD publish --npm --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"npm"* || "$output" == *"publishing"* ]]
}

@test "publish with skip-registry skips registry updates" {
  create_plugin skipplugin
  run $ELIZAOS_CMD publish --skip-registry --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" != *"registry"* || "$output" == *"skipping"* ]]
}
