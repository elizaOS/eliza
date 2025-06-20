#!/usr/bin/env bats

load '../helpers/test-helpers'

setup() {
  setup_test_environment
}

teardown() {
  teardown_test_environment
}

@test "test: shows help with --help flag" {
  run run_cli "dist" test --help
  assert_cli_success
  assert_output --partial "Run tests for the current project"
  assert_output --partial "--type"
  assert_output --partial "--skip-build"
}

@test "test: runs component tests in project" {
  create_test_project "test-project"
  cd test-project
  
  # Create a simple test file
  mkdir -p tests
  cat > tests/sample.test.js <<EOF
import { describe, it, expect } from 'bun:test';

describe('Sample Test', () => {
  it('should pass', () => {
    expect(true).toBe(true);
  });
});
EOF
  
  run run_cli "dist" test --type component --skip-build
  assert_cli_success
  assert_output --partial "Component tests"
}

@test "test: fails when build fails" {
  create_test_project "broken-project"
  cd broken-project
  
  # Create invalid TypeScript that will fail build
  mkdir -p src
  cat > src/index.ts <<EOF
const x: string = 123; // Type error
EOF
  
  # Add TypeScript to package.json
  cat > tsconfig.json <<EOF
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "node"
  },
  "include": ["src/**/*"]
}
EOF
  
  run run_cli "dist" test
  assert_cli_failure
  # Either TypeScript validation failed or build failed
  [[ "$output" =~ "TypeScript validation failed" ]] || [[ "$output" =~ "Build" ]] || [[ "$output" =~ "error" ]]
}

@test "test: runs with --skip-build flag" {
  create_test_project "skip-build-project"
  cd skip-build-project
  
  mkdir -p tests
  cat > tests/quick.test.js <<EOF
console.log('Quick test');
EOF
  
  run run_cli "dist" test --skip-build
  assert_cli_success
}

@test "test: filters tests by name" {
  create_test_project "filter-project"
  cd filter-project
  
  mkdir -p tests
  cat > tests/specific.test.js <<EOF
import { describe, it, expect } from 'bun:test';

describe('Specific Test', () => {
  it('should run this test', () => {
    expect(true).toBe(true);
  });
});

describe('Other Test', () => {
  it('should not run this test', () => {
    expect(false).toBe(true);
  });
});
EOF
  
  run run_cli "dist" test --name "Specific" --skip-build
  assert_cli_success
  assert_output --partial "Specific Test"
}

@test "test: isolates plugin tests properly" {
  # Create a workspace with two plugins
  mkdir -p workspace/packages/{plugin-a,plugin-b}
  cd workspace
  
  # Create workspace package.json
  cat > package.json <<EOF
{
  "name": "test-workspace",
  "private": true,
  "workspaces": ["packages/*"]
}
EOF
  
  # Plugin A with passing test
  cd packages/plugin-a
  cat > package.json <<EOF
{
  "name": "@test/plugin-a",
  "version": "1.0.0",
  "type": "module"
}
EOF
  
  mkdir -p src
  cat > src/plugin-a.test.ts <<EOF
import { describe, it, expect } from 'bun:test';

describe('Plugin A', () => {
  it('passes', () => {
    expect(true).toBe(true);
  });
});
EOF
  
  # Plugin B with failing test
  cd ../plugin-b
  cat > package.json <<EOF
{
  "name": "@test/plugin-b",
  "version": "1.0.0",
  "type": "module"
}
EOF
  
  mkdir -p src
  cat > src/plugin-b.test.ts <<EOF
import { describe, it, expect } from 'bun:test';

describe('Plugin B', () => {
  it('fails', () => {
    expect(true).toBe(false);
  });
});
EOF
  
  # Test only plugin A - should pass
  cd ../plugin-a
  run run_cli "dist" test . --skip-build
  assert_cli_success
  assert_output --partial "Plugin A"
  refute_output --partial "Plugin B"
}

@test "test: validates TypeScript before running tests" {
  create_test_project "ts-project"
  cd ts-project
  
  # Create TypeScript with errors
  mkdir -p src
  cat > src/index.ts <<EOF
const x: string = 123; // Type error
const y: number = "hello"; // Another type error

export { x, y };
EOF
  
  # Create strict tsconfig
  cat > tsconfig.json <<EOF
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "node"
  },
  "include": ["src/**/*"]
}
EOF
  
  # Add a passing test
  mkdir -p tests
  cat > tests/pass.test.js <<EOF
import { describe, it, expect } from 'bun:test';

describe('Pass', () => {
  it('passes', () => {
    expect(true).toBe(true);
  });
});
EOF
  
  run run_cli "dist" test --skip-build --type component
  assert_cli_failure
  assert_output --partial "TypeScript validation failed"
}

@test "test: skips TypeScript check with flag" {
  create_test_project "skip-ts-project"
  cd skip-ts-project
  
  # Create TypeScript with errors
  mkdir -p src
  cat > src/index.ts <<EOF
const x: string = 123; // Type error
EOF
  
  cat > tsconfig.json <<EOF
{
  "compilerOptions": {
    "strict": true
  }
}
EOF
  
  # Add a passing test
  mkdir -p tests
  cat > tests/pass.test.js <<EOF
console.log('Test passes');
EOF
  
  run run_cli "dist" test --skip-build --skip-type-check
  assert_cli_success
} 