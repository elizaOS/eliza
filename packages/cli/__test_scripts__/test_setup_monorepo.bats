#!/usr/bin/env bats

setup() {
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-XXXXXX)"
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run "$(cd ../dist && pwd)/index.js"}"
  cd "$TEST_TMP_DIR"
  
  # Save the old git command
  if command -v git >/dev/null 2>&1; then
    GIT_CMD=$(which git)
  else
    GIT_CMD="git"
  fi
  
  # Create a mock git script
  mkdir -p "$TEST_TMP_DIR/bin"
  cat > "$TEST_TMP_DIR/bin/git" <<EOF
#!/bin/bash
echo "\$@" > "$TEST_TMP_DIR/git_args.txt"
if [ "\$1" = "clone" ]; then
  # Create directories instead of actually cloning
  dest="\${@: -1}" # Get the last argument (destination)
  mkdir -p "\$dest/packages"
  echo "{}" > "\$dest/package.json"
  mkdir -p "\$dest/.git"
fi
exit 0
EOF
  chmod +x "$TEST_TMP_DIR/bin/git"
  
  # Add our mock to the PATH
  export PATH="$TEST_TMP_DIR/bin:$PATH"
}

teardown() {
  if [ -n "$TEST_TMP_DIR" ] && [[ "$TEST_TMP_DIR" == /var/tmp/eliza-test-* ]]; then
    rm -rf "$TEST_TMP_DIR"
  fi
}

# Check that the help command displays usage
@test "setup-monorepo --help shows usage" {
  run $ELIZAOS_CMD setup-monorepo --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos setup-monorepo"* ]]
  [[ "$output" == *"-b, --branch"* ]]
  [[ "$output" == *"-d, --dir"* ]]
}

# Test with default parameters
@test "setup-monorepo uses default branch and directory" {
  run $ELIZAOS_CMD setup-monorepo
  [ "$status" -eq 0 ]
  
  # Verify default directory was created
  [ -d "./eliza" ]
  [ -f "./eliza/package.json" ]
  
  # When successful directory creation happens, that's good enough
  # to know the correct directory was passed to git clone
}

# Test with custom branch
@test "setup-monorepo respects custom branch" {
  run $ELIZAOS_CMD setup-monorepo --branch test-branch
  [ "$status" -eq 0 ]
  
  # Check git args were correct
  [ -f "$TEST_TMP_DIR/git_args.txt" ]
  run cat "$TEST_TMP_DIR/git_args.txt"
  [[ "$output" == *"-b test-branch"* ]]
}

# Test with custom directory
@test "setup-monorepo respects custom directory" {
  run $ELIZAOS_CMD setup-monorepo --dir custom-dir
  [ "$status" -eq 0 ]
  
  # Verify custom directory was created
  [ -d "./custom-dir" ]
  [ -f "./custom-dir/package.json" ]
  
  # Check git args were correct
  [ -f "$TEST_TMP_DIR/git_args.txt" ]
  run cat "$TEST_TMP_DIR/git_args.txt"
  [[ "$output" == *"custom-dir"* ]]
}

# Test with both custom branch and directory
@test "setup-monorepo respects both custom branch and directory" {
  run $ELIZAOS_CMD setup-monorepo -b feature-branch -d my-eliza-dir
  [ "$status" -eq 0 ]
  
  # Verify custom directory was created
  [ -d "./my-eliza-dir" ]
  [ -f "./my-eliza-dir/package.json" ]
  
  # Check git args were correct
  [ -f "$TEST_TMP_DIR/git_args.txt" ]
  run cat "$TEST_TMP_DIR/git_args.txt"
  [[ "$output" == *"-b feature-branch"* ]]
  [[ "$output" == *"my-eliza-dir"* ]]
}

# Test for error when directory is not empty
@test "setup-monorepo fails when directory is not empty" {
  # Create a non-empty directory
  mkdir -p not-empty-dir
  touch not-empty-dir/some-file.txt
  
  run $ELIZAOS_CMD setup-monorepo -d not-empty-dir
  [ "$status" -ne 0 ]
  [[ "$output" == *"not empty"* ]]
} 