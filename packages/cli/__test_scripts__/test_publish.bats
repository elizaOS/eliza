#!/usr/bin/env bats

# -----------------------------------------------------------------------------
# plugins publish tests: validate / pack / bump-version flows run inside freshly
# scaffolded plugin workspaces.  These tests mostly guarantee the sub‑command is
# wired and does not error out with "command not found" (127) or similar.
# -----------------------------------------------------------------------------

setup() {
  set -euo pipefail

  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-publish-XXXXXX)"
  cd "$TEST_TMP_DIR"

  # Ensure the CLI bundle exists (developers sometimes forget to build).
  if [ ! -f "$BATS_TEST_DIRNAME/../dist/index.js" ]; then
    (cd "$BATS_TEST_DIRNAME/.." && bun run build)
  fi
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run $(cd "$BATS_TEST_DIRNAME/../dist" && pwd)/index.js}"
}

teardown() {
  [[ -n "${TEST_TMP_DIR:-}" && "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]] && rm -rf "$TEST_TMP_DIR"
}

# -----------------------------------------------------------------------------
# --help sanity
# -----------------------------------------------------------------------------
@test "plugins publish help displays usage information" {
  run $ELIZAOS_CMD plugins publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Manage ElizaOS plugins"* ]]
  [[ "$output" =~ (validate|pack|bump-version) ]]
}

# -----------------------------------------------------------------------------
# publish sub‑commands inside a freshly scaffolded plugin workspace
# -----------------------------------------------------------------------------
create_plugin() {
  local name="$1"
  run $ELIZAOS_CMD create "$name" --yes --type plugin
  [ "$status" -eq 0 ]
  cd "plugin-$name"
}

@test "plugins publish --validate runs in plugins project" {
  create_plugin myplugins
  run $ELIZAOS_CMD plugins publish --validate
  [ "$status" -eq 0 ]
}

@test "plugins publish --pack runs in plugins project" {
  create_plugin pkgplugins
  run $ELIZAOS_CMD plugins publish --pack
  [ "$status" -eq 0 ]
  # Optional: ensure a .tgz got created in the workspace.
  ls *.tgz >/dev/null 2>&1
}

@test "plugins publish with auth flag runs" {
  create_plugin pubplugins
  run $ELIZAOS_CMD plugins publish --auth "fake-token"
  [ "$status" -eq 0 ]
}

@test "plugins publish --bump-version runs" {
  create_plugin verplugins
  run $ELIZAOS_CMD plugins publish --bump-version
  [ "$status" -eq 0 ]
}
