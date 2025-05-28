#!/usr/bin/env bats

# -----------------------------------------------------------------------------
# setup‑monorepo command tests.  A mock git binary is injected into PATH so that
# the CLI thinks it performed a clone without touching the network.
# -----------------------------------------------------------------------------

setup() {
  set -euo pipefail

  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-monorepo-XXXXXX)"
  cd "$TEST_TMP_DIR"

  # Resolve CLI path (allow override via ELIZAOS_CMD env).
  # Source common utilities
  source "$BATS_TEST_DIRNAME/common.sh"
  setup_elizaos_cmd

  # ---------------------------------------------------------------------------
  # Fake git implementation that records its argv and creates a dummy repo.
  # ---------------------------------------------------------------------------
  mkdir -p bin
  cat > bin/git <<'EOS'
#!/usr/bin/env bash
printf '%q ' "$@" > "${TEST_TMP_DIR}/git_args.txt"
if [[ "$1" == clone ]]; then
  dest="${@: -1}"
  mkdir -p "$dest/packages" "$dest/.git"
  echo '{}' > "$dest/package.json"
fi
EOS
  chmod +x bin/git
  export PATH="$TEST_TMP_DIR/bin:$PATH"
}

teardown() {
  [[ -n "${TEST_TMP_DIR:-}" && "$TEST_TMP_DIR" == /var/tmp/eliza-test-monorepo-* ]] && rm -rf "$TEST_TMP_DIR"
}

# -----------------------------------------------------------------------------
# --help
# -----------------------------------------------------------------------------
@test "setup-monorepo --help shows usage" {
  run $ELIZAOS_CMD setup-monorepo --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos setup-monorepo"* ]]
  for opt in -b --branch -d --dir; do [[ "$output" == *"$opt"* ]]; done
}

# -----------------------------------------------------------------------------
# Default invocation clones into ./eliza on default branch
# -----------------------------------------------------------------------------
@test "setup-monorepo uses default branch and directory" {
  run $ELIZAOS_CMD setup-monorepo
  [ "$status" -eq 0 ]
  [ -d eliza ] && [ -f eliza/package.json ]
}

# -----------------------------------------------------------------------------
# Custom branch
# -----------------------------------------------------------------------------
@test "setup-monorepo respects custom branch" {
  run $ELIZAOS_CMD setup-monorepo --branch test-branch
  [ "$status" -eq 0 ]
  run cat "$TEST_TMP_DIR/git_args.txt"
  [ "$status" -eq 0 ]
  [[ "$output" == *"-b"*test-branch* ]]
}

# -----------------------------------------------------------------------------
# Custom directory
# -----------------------------------------------------------------------------
@test "setup-monorepo respects custom directory" {
  run $ELIZAOS_CMD setup-monorepo --dir custom-dir
  [ "$status" -eq 0 ]
  [ -d custom-dir ] && [ -f custom-dir/package.json ]
  run cat "$TEST_TMP_DIR/git_args.txt"
  [[ "$output" == *"custom-dir"* ]]
}

# -----------------------------------------------------------------------------
# Custom branch + directory
# -----------------------------------------------------------------------------
@test "setup-monorepo respects both custom branch and directory" {
  run $ELIZAOS_CMD setup-monorepo -b feature-branch -d my-eliza-dir
  [ "$status" -eq 0 ]
  [ -d my-eliza-dir ] && [ -f my-eliza-dir/package.json ]
  run cat "$TEST_TMP_DIR/git_args.txt"
  [[ "$output" == *"-b"*feature-branch* ]] && [[ "$output" == *"my-eliza-dir"* ]]
}

# -----------------------------------------------------------------------------
# Directory must be empty
# -----------------------------------------------------------------------------
@test "setup-monorepo fails when directory is not empty" {
  mkdir -p not-empty-dir && touch not-empty-dir/placeholder
  run $ELIZAOS_CMD setup-monorepo --dir not-empty-dir
  [ "$status" -ne 0 ]
  [[ "$output" == *"not empty"* ]]
}
