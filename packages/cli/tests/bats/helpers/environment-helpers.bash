#!/usr/bin/env bash

# Environment detection and normalization helpers

# Detect if we're running in TypeScript or JavaScript environment
detect_runtime_environment() {
  local test_file="test-env-detect.ts"
  
  # Try to run a TypeScript file directly
  echo "console.log('ts')" > "$test_file"
  
  if bun run "$test_file" >/dev/null 2>&1; then
    rm -f "$test_file"
    echo "typescript"
  else
    rm -f "$test_file"
    echo "javascript"
  fi
}

# Detect if we're inside the monorepo
is_monorepo_context() {
  local current_dir="$(pwd)"
  local check_dir="$current_dir"
  
  while [[ "$check_dir" != "/" ]]; do
    if [[ -f "$check_dir/pnpm-workspace.yaml" ]] || [[ -f "$check_dir/lerna.json" ]]; then
      return 0
    fi
    check_dir="$(dirname "$check_dir")"
  done
  
  return 1
}

# Get the appropriate file extension based on environment
get_file_extension() {
  local env="${1:-$(detect_runtime_environment)}"
  
  if [[ "$env" == "typescript" ]]; then
    echo ".ts"
  else
    echo ".js"
  fi
}

# Create a test plugin with proper file extensions
create_test_plugin() {
  local plugin_name="${1:-test-plugin}"
  local use_typescript="${2:-auto}"
  
  if [[ "$use_typescript" == "auto" ]]; then
    use_typescript=$(detect_runtime_environment)
  fi
  
  local ext=$(get_file_extension "$use_typescript")
  
  mkdir -p "$plugin_name/src"
  cd "$plugin_name"
  
  # Create package.json
  cat > package.json <<EOF
{
  "name": "@elizaos/plugin-$plugin_name",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run"
  },
  "dependencies": {
    "@elizaos/core": "workspace:*"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.3.0",
    "vitest": "^1.0.0"
  },
  "peerDependencies": {
    "@elizaos/core": "workspace:*"
  }
}
EOF

  # Create tsconfig.json
  cat > tsconfig.json <<EOF
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "lib": ["ES2022"],
    "moduleResolution": "node",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
EOF

  # Create plugin source file
  if [[ "$use_typescript" == "typescript" ]]; then
    cat > "src/index.ts" <<'EOF'
import { Plugin, IAgentRuntime, Action } from '@elizaos/core';

const testAction: Action = {
  name: 'TEST_ACTION',
  description: 'A test action',
  validate: async (runtime: IAgentRuntime, message: any) => true,
  handler: async (runtime: IAgentRuntime, message: any) => {
    return {
      text: 'Test action executed',
      action: 'TEST_ACTION'
    };
  },
  examples: []
};

export const testPlugin: Plugin = {
  name: '@elizaos/plugin-test-plugin',
  description: 'A test plugin for CLI testing',
  actions: [testAction],
  providers: [],
  services: []
};

export default testPlugin;
EOF
  else
    # For JavaScript, create pre-built version
    mkdir -p dist
    cat > "dist/index.js" <<'EOF'
export const testAction = {
  name: 'TEST_ACTION',
  description: 'A test action',
  validate: async (runtime, message) => true,
  handler: async (runtime, message) => {
    return {
      text: 'Test action executed',
      action: 'TEST_ACTION'
    };
  },
  examples: []
};

export const testPlugin = {
  name: '@elizaos/plugin-test-plugin',
  description: 'A test plugin for CLI testing',
  actions: [testAction],
  providers: [],
  services: []
};

export default testPlugin;
EOF
  fi

  cd ..
}

# Create a project with agents configured
create_test_project_with_agents() {
  local project_name="${1:-test-project}"
  local use_typescript="${2:-auto}"
  
  if [[ "$use_typescript" == "auto" ]]; then
    use_typescript=$(detect_runtime_environment)
  fi
  
  mkdir -p "$project_name/src"
  cd "$project_name"
  
  # Create package.json with elizaos config
  cat > package.json <<EOF
{
  "name": "$project_name",
  "version": "1.0.0",
  "type": "module",
  "main": "./src/index.js",
  "scripts": {
    "start": "elizaos start",
    "test": "elizaos test"
  },
  "dependencies": {
    "@elizaos/core": "latest",
    "@elizaos/cli": "latest"
  },
  "elizaos": {
    "plugins": ["@elizaos/plugin-message-handling"],
    "agents": [
      {
        "character": "./characters/agent1.json"
      }
    ]
  }
}
EOF

  # Create character file
  mkdir -p characters
  cat > characters/agent1.json <<EOF
{
  "name": "ProjectAgent",
  "description": "An agent configured in project",
  "modelProvider": "openai",
  "plugins": ["@elizaos/plugin-message-handling"],
  "settings": {
    "secrets": {},
    "voice": {
      "model": "en_US-male-medium"
    }
  }
}
EOF

  # Create .env file
  cat > .env <<EOF
# Test environment variables
NODE_ENV=test
OPENAI_API_KEY=test-key
EOF

  cd ..
}

# Normalize import paths for TypeScript/JavaScript compatibility
normalize_import_path() {
  local import_path="$1"
  local runtime_env="${2:-$(detect_runtime_environment)}"
  
  if [[ "$runtime_env" == "javascript" ]]; then
    # Add .js extension if missing and it's a relative import
    if [[ "$import_path" =~ ^\./|^\.\.\/ ]] && [[ ! "$import_path" =~ \.(js|json)$ ]]; then
      echo "${import_path}.js"
    else
      echo "$import_path"
    fi
  else
    # TypeScript can handle without extensions
    echo "$import_path"
  fi
}

# Create a standalone project outside monorepo
create_standalone_project() {
  local project_name="${1:-standalone-project}"
  local temp_dir="$(mktemp -d -t eliza-standalone.XXXXXX)"
  
  cd "$temp_dir"
  create_test_project_with_agents "$project_name"
  
  echo "$temp_dir/$project_name"
}

# Test file resolution in different contexts
test_file_resolution() {
  local file_path="$1"
  local context="${2:-current}"
  
  case "$context" in
    "monorepo")
      # Test from monorepo root
      cd "$MONOREPO_ROOT"
      [[ -f "$file_path" ]] && echo "found" || echo "not-found"
      ;;
    "package")
      # Test from package directory
      cd "$CLI_ROOT"
      [[ -f "$file_path" ]] && echo "found" || echo "not-found"
      ;;
    "current")
      # Test from current directory
      [[ -f "$file_path" ]] && echo "found" || echo "not-found"
      ;;
  esac
}

# Create test fixtures for different environments
setup_environment_test_fixtures() {
  local fixture_dir="${1:-fixtures}"
  
  mkdir -p "$fixture_dir"
  
  # TypeScript project
  mkdir -p "$fixture_dir/ts-project"
  cd "$fixture_dir/ts-project"
  create_test_project_with_agents "ts-project" "typescript"
  cd ../..
  
  # JavaScript project
  mkdir -p "$fixture_dir/js-project"
  cd "$fixture_dir/js-project"
  create_test_project_with_agents "js-project" "javascript"
  cd ../..
  
  # Plugin project
  mkdir -p "$fixture_dir/plugin-project"
  cd "$fixture_dir/plugin-project"
  create_test_plugin "test-plugin"
  cd ../..
}

# Export functions for use in tests
export -f detect_runtime_environment
export -f is_monorepo_context
export -f get_file_extension
export -f create_test_plugin
export -f create_test_project_with_agents
export -f normalize_import_path
export -f create_standalone_project
export -f test_file_resolution
export -f setup_environment_test_fixtures 