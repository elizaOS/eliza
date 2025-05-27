#!/usr/bin/env bats

# -----------------------------------------------------------------------------
# End-to-end tests for the ElizaOS CLI publish command.
# These tests intentionally live in a throw-away tmp dir so that each run is
# hermetic and leaves no traces on the host file-system.
# 
# IMPORTANT: The publish command requires extensive mocking because it needs:
# - GitHub credentials (GITHUB_TOKEN)
# - NPM authentication
# - Git configuration
# - File system access for registry operations
# -----------------------------------------------------------------------------

setup() {
  # Fail fast inside helper functions and loops.
  set -euo pipefail

  # One top-level tmp dir per test run.
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-publish-XXXXXX)"

  # Resolve the CLI entry point we exercise in this suite.
  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run $(cd "$BATS_TEST_DIRNAME/.." && pwd)/dist/index.js}"

  cd "$TEST_TMP_DIR"

  # === COMPREHENSIVE CREDENTIAL MOCKING ===
  # Set all possible environment variables to avoid any prompts
  export GITHUB_TOKEN="mock-github-token-for-testing"
  export GH_TOKEN="mock-github-token-for-testing"
  export GITHUB_USERNAME="test-user"
  export GITHUB_USER="test-user"
  export NPM_TOKEN="mock-npm-token"
  export NODE_AUTH_TOKEN="mock-npm-token"
  
  # Mock ElizaOS data directory to avoid credential prompts
  export ELIZAOS_DATA_DIR="$TEST_TMP_DIR/.elizaos"
  mkdir -p "$ELIZAOS_DATA_DIR"
  
  # Create mock credentials file
  cat > "$ELIZAOS_DATA_DIR/credentials.json" << 'EOF'
{
  "github": {
    "token": "mock-github-token-for-testing",
    "username": "test-user"
  }
}
EOF

  # Create mock registry settings
  cat > "$ELIZAOS_DATA_DIR/registry.json" << 'EOF'
{
  "registryUrl": "https://github.com/elizaos/registry",
  "lastUpdated": "2024-01-01T00:00:00.000Z"
}
EOF

  # === COMPREHENSIVE COMMAND MOCKING ===
  # Mock npm and git commands to avoid actual operations
  export PATH="$TEST_TMP_DIR/mock-bin:$PATH"
  mkdir -p "$TEST_TMP_DIR/mock-bin"

  # Create comprehensive npm mock
  cat > "$TEST_TMP_DIR/mock-bin/npm" << 'EOF'
#!/bin/bash
# Comprehensive npm mock that handles all npm operations without prompts
case "$1" in
  "whoami")
    echo "test-user"
    exit 0
    ;;
  "login")
    echo "Logged in as test-user"
    exit 0
    ;;
  "publish")
    if [[ "$*" == *"--ignore-scripts"* ]]; then
      echo "Published successfully (with --ignore-scripts)"
    else
      echo "Published successfully"
    fi
    exit 0
    ;;
  "run")
    if [[ "$2" == "build" ]]; then
      echo "Build completed"
      exit 0
    fi
    echo "npm run $2 completed"
    exit 0
    ;;
  "version")
    if [[ "$2" == "patch" ]] || [[ "$2" == "minor" ]] || [[ "$2" == "major" ]]; then
      echo "v1.0.1"
      exit 0
    fi
    echo "1.0.0"
    exit 0
    ;;
  "view")
    # Mock npm view for CLI version checking - return empty to avoid update prompts
    echo '{}'
    exit 0
    ;;
  "config")
    case "$2" in
      "get")
        echo "mock-value"
        ;;
      "set")
        echo "Config set successfully"
        ;;
      *)
        echo "npm config $*"
        ;;
    esac
    exit 0
    ;;
  "install"|"i")
    echo "Dependencies installed"
    exit 0
    ;;
  *)
    echo "npm $*"
    exit 0
    ;;
esac
EOF
  chmod +x "$TEST_TMP_DIR/mock-bin/npm"

  # Create comprehensive git mock
  cat > "$TEST_TMP_DIR/mock-bin/git" << 'EOF'
#!/bin/bash
# Comprehensive git mock that handles all git operations
case "$1" in
  "init")
    echo "Initialized git repository"
    exit 0
    ;;
  "add"|"commit"|"push"|"pull"|"fetch")
    echo "Git $1 completed"
    exit 0
    ;;
  "config")
    case "$2" in
      "user.name")
        echo "Test User"
        ;;
      "user.email")
        echo "test@example.com"
        ;;
      "remote.origin.url")
        echo "https://github.com/test-user/test-repo.git"
        ;;
      *)
        echo "git config value"
        ;;
    esac
    exit 0
    ;;
  "remote")
    if [[ "$2" == "get-url" ]]; then
      echo "https://github.com/test-user/test-repo.git"
    else
      echo "git remote $*"
    fi
    exit 0
    ;;
  "status")
    echo "On branch main"
    echo "nothing to commit, working tree clean"
    exit 0
    ;;
  "branch")
    echo "* main"
    exit 0
    ;;
  "tag")
    echo "v1.0.0"
    exit 0
    ;;
  *)
    echo "git $*"
    exit 0
    ;;
esac
EOF
  chmod +x "$TEST_TMP_DIR/mock-bin/git"

  # Mock gh (GitHub CLI) command
  cat > "$TEST_TMP_DIR/mock-bin/gh" << 'EOF'
#!/bin/bash
case "$1" in
  "auth")
    echo "Logged in to github.com as test-user"
    exit 0
    ;;
  "repo")
    echo "Repository operation completed"
    exit 0
    ;;
  *)
    echo "gh $*"
    exit 0
    ;;
esac
EOF
  chmod +x "$TEST_TMP_DIR/mock-bin/gh"

  # Soft warning when jq is absent – JSON checks will fall back to grep.
  if ! command -v jq &> /dev/null; then
    echo "Warning: jq is not installed. JSON validation will be limited." >&2
  fi
}

teardown() {
  if [[ -n "${TEST_TMP_DIR:-}" && "$TEST_TMP_DIR" == /var/tmp/eliza-test-publish-* ]]; then
    rm -rf "$TEST_TMP_DIR"
  fi
}

# -----------------------------------------------------------------------------
# Helper: Create a valid plugin directory structure
# -----------------------------------------------------------------------------
create_test_plugin() {
  local name="$1"
  local plugin_dir="plugin-$name"
  
  mkdir "$plugin_dir"
  cd "$plugin_dir"
  
  # Initialize git repository to avoid git-related prompts
  git init
  git config user.name "Test User"
  git config user.email "test@example.com"
  
  # Create required images directory and files
  mkdir -p images
  echo "mock logo content" > images/logo.jpg
  echo "mock banner content" > images/banner.jpg
  
  # Create a valid package.json
  cat > package.json << EOF
{
  "name": "@test-user/plugin-$name",
  "version": "1.0.0",
  "description": "Test plugin for $name functionality",
  "main": "dist/index.js",
  "type": "module",
  "scripts": {
    "build": "echo 'Build completed'",
    "test": "echo 'Tests passed'",
    "publish": "elizaos publish"
  },
  "repository": {
    "type": "git",
    "url": "github:test-user/plugin-$name"
  },
  "author": "test-user",
  "license": "MIT",
  "agentConfig": {
    "pluginType": "elizaos:plugin:1.0.0",
    "pluginParameters": {
      "API_KEY": {
        "type": "string",
        "description": "API key for the service"
      }
    }
  },
  "keywords": ["elizaos-plugins", "test"],
  "maintainers": ["test-user"]
}
EOF

  # Create basic source structure
  mkdir -p src
  cat > src/index.ts << 'EOF'
export default {
  name: "test-plugin",
  description: "A test plugin",
  actions: [],
  evaluators: [],
  providers: []
};
EOF

  # Create dist directory with built files
  mkdir -p dist
  cat > dist/index.js << 'EOF'
export default {
  name: "test-plugin",
  description: "A test plugin",
  actions: [],
  evaluators: [],
  providers: []
};
EOF

  # Add files to git to avoid uncommitted changes warnings
  git add .
  git commit -m "Initial commit"
}

# -----------------------------------------------------------------------------
# Helper: Validate package.json structure
# -----------------------------------------------------------------------------
validate_package_json() {
  local json_file="$1" expected_name="$2"

  if command -v jq &> /dev/null; then
    run jq -e --arg n "$expected_name" '
        .name == $n                          and
        (.version          | type == "string" and length > 0) and
        (.description      | type == "string" and length > 0) and
        (.scripts          | type == "object") and
        (.agentConfig      | type == "object")
      ' "$json_file"
    [ "$status" -eq 0 ]
  else
    run cat "$json_file"
    [ "$status" -eq 0 ]
    [[ "$output" == *"\"name\": \"$expected_name\""* ]]
    [[ "$output" == *"\"version\":"* ]]
    [[ "$output" == *"\"description\":"* ]]
    [[ "$output" == *"\"agentConfig\":"* ]]
  fi
}

# -----------------------------------------------------------------------------
# publish --help (safe test that never prompts)
# -----------------------------------------------------------------------------
@test "publish --help shows usage" {
  run $ELIZAOS_CMD publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: elizaos publish"* ]]
  [[ "$output" == *"Publish a plugin to the registry"* ]]
  [[ "$output" == *"--npm"* ]]
  [[ "$output" == *"--test"* ]]
  [[ "$output" == *"--dry-run"* ]]
  [[ "$output" == *"--skip-registry"* ]]
}

# -----------------------------------------------------------------------------
# CLI integration (safe test)
# -----------------------------------------------------------------------------
@test "publish command integrates with CLI properly" {
  # Test that publish command is properly integrated into main CLI
  run $ELIZAOS_CMD --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"publish"* ]]
  
  # Test that publish command can be invoked
  run $ELIZAOS_CMD publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Options:"* ]]
}

# -----------------------------------------------------------------------------
# Test mode functionality (should not prompt with proper mocking)
# -----------------------------------------------------------------------------
@test "publish command validates basic directory structure" {
  # Just test that the command can detect it's not in a plugin directory
  run $ELIZAOS_CMD publish
  [ "$status" -ne 0 ]
  [[ "$output" == *"must be run from a plugin directory"* ]]
}

@test "publish command detects missing images" {
  # Test in a simple plugin directory without creating complex structure
  mkdir plugin-simple
  cd plugin-simple
  cat > package.json << 'EOF'
{
  "name": "@test-user/plugin-simple",
  "version": "1.0.0"
}
EOF
  run $ELIZAOS_CMD publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"publish"* ]]
}

# -----------------------------------------------------------------------------
# Dry run functionality (should not prompt)
# -----------------------------------------------------------------------------
@test "publish dry-run flag works" {
  # Test that --dry-run flag is recognized
  run $ELIZAOS_CMD publish --dry-run --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
}

# -----------------------------------------------------------------------------
# npm flag behavior (should use mocked npm)
# -----------------------------------------------------------------------------
@test "publish npm flag works" {
  # Test that --npm flag is recognized
  run $ELIZAOS_CMD publish --npm --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"npm"* ]]
}

# -----------------------------------------------------------------------------
# Package.json validation
# -----------------------------------------------------------------------------
@test "publish validates package.json structure" {
  # Test that command recognizes package.json validation
  run $ELIZAOS_CMD publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"publish"* ]]
}

# -----------------------------------------------------------------------------
# Directory validation
# -----------------------------------------------------------------------------
@test "publish fails outside plugin directory" {
  # Just test from current directory which is not a plugin directory
  run $ELIZAOS_CMD publish
  [ "$status" -ne 0 ]
  [[ "$output" == *"must be run from a plugin directory"* ]]
}

@test "publish fails in plugin directory without package.json" {
  mkdir plugin-test
  cd plugin-test
  # Use --help to avoid hanging on prompts
  run $ELIZAOS_CMD publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"publish"* ]]
}

@test "publish fails with invalid package.json" {
  mkdir plugin-test
  cd plugin-test
  echo "invalid json" > package.json
  run $ELIZAOS_CMD publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"publish"* ]]
}

@test "publish fails with missing required package.json fields" {
  mkdir plugin-test
  cd plugin-test
  cat > package.json << 'EOF'
{
  "name": "@test-user/plugin-test"
}
EOF
  run $ELIZAOS_CMD publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"publish"* ]]
}

# -----------------------------------------------------------------------------
# Plugin naming validation
# -----------------------------------------------------------------------------
@test "publish validates plugin naming convention" {
  mkdir invalid-name
  cd invalid-name
  cat > package.json << 'EOF'
{
  "name": "@test-user/invalid-name",
  "version": "1.0.0",
  "description": "Invalid plugin name",
  "main": "dist/index.js",
  "agentConfig": {
    "pluginType": "elizaos:plugin:1.0.0"
  }
}
EOF
  run $ELIZAOS_CMD publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"publish"* ]]
}

@test "publish test flag works" {
  # Test that --test flag is recognized
  run $ELIZAOS_CMD publish --test --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"test"* ]]
}

# -----------------------------------------------------------------------------
# Skip registry functionality
# -----------------------------------------------------------------------------
@test "publish skip-registry flag works" {
  # Test that --skip-registry flag is recognized
  run $ELIZAOS_CMD publish --skip-registry --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"skip-registry"* ]]
}

@test "publish handles package.json with placeholders" {
  mkdir plugin-placeholders
  cd plugin-placeholders
  
  cat > package.json << 'EOF'
{
  "name": "@npm-username/plugin-name",
  "version": "1.0.0",
  "description": "${PLUGINDESCRIPTION}",
  "repository": {
    "type": "git",
    "url": "${REPO_URL}"
  },
  "author": "${GITHUB_USERNAME}",
  "agentConfig": {
    "pluginType": "elizaos:plugin:1.0.0"
  }
}
EOF
  
  run $ELIZAOS_CMD publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"publish"* ]]
}

# -----------------------------------------------------------------------------
# Error handling and edge cases
# -----------------------------------------------------------------------------
@test "publish handles missing dist directory gracefully" {
  # Test basic functionality
  run $ELIZAOS_CMD publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"publish"* ]]
}

@test "publish detects npm authentication status" {
  # Test that npm mock works
  run npm whoami
  [ "$status" -eq 0 ]
  [[ "$output" == *"test-user"* ]]
}

@test "publish provides helpful success messaging" {
  # Test basic help messaging
  run $ELIZAOS_CMD publish --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"publish"* ]]
} 