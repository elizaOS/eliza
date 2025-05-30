---
sidebar_position: 6
title: Test Command
description: Run and manage tests for ElizaOS projects and plugins
keywords: [testing, component tests, e2e tests, Vitest, test runner, development]
image: /img/cli.jpg
---

# Test Command

Run tests for Eliza agent projects and plugins.

## Usage

```bash
elizaos test [options] [command]
```

## Subcommands

| Subcommand  | Description                                |
| ----------- | ------------------------------------------ |
| `component` | Run component tests (via Vitest)           |
| `e2e`       | Run end-to-end runtime tests               |
| `all`       | Run both component and e2e tests (default) |

## Options

| Option              | Description                                                   |
| ------------------- | ------------------------------------------------------------- |
| `-p, --port <port>` | Server port for e2e tests                                     |
| `-n, --name <n>`    | Filter tests by name (matches file names or test suite names) |
| `--skip-build`      | Skip building before running tests                            |

## Examples

### Basic Test Execution

```bash
# Run all tests (component and e2e) - default behavior
elizaos test

# Explicitly run all tests
elizaos test all

# Run only component tests
elizaos test component

# Run only end-to-end tests
elizaos test e2e
```

### Test Filtering

```bash
# Filter component tests by name
elizaos test component --name auth

# Filter e2e tests by name
elizaos test e2e --name database

# Filter all tests by name
elizaos test --name plugin
```

### Advanced Options

```bash
# Run tests on custom port for e2e
elizaos test e2e --port 4000

# Skip building before running tests
elizaos test --skip-build

# Combine options
elizaos test e2e --port 3001 --name integration --skip-build
```

## Test Types

### Component Tests

**Location**: `__tests__/` directory  
**Framework**: Vitest  
**Purpose**: Unit and integration testing of individual components

### End-to-End Tests

**Location**: `e2e/` directory  
**Framework**: Custom ElizaOS test runner  
**Purpose**: Runtime behavior testing with full agent context

## Automatic Building

The `elizaos test` command automatically builds your project or plugin before running tests to ensure you're testing the latest code. This includes:

- **TypeScript compilation**: Compiles `.ts` files to JavaScript
- **Dependency resolution**: Ensures all imports are resolved
- **Plugin packaging**: Prepares plugins for testing

### Build Behavior

```bash
# These commands automatically build before running tests:
elizaos test           # Builds once for component tests, skips build for e2e
elizaos test component # Builds before running component tests
elizaos test e2e       # Builds before running e2e tests

# Skip the automatic build (useful for build troubleshooting):
elizaos test --skip-build
```

### When Build Fails

If the automatic build fails, the test command will:

1. Log the build error
2. Warn that it's continuing despite the error
3. Attempt to run tests anyway (may fail if build artifacts are missing)

## Troubleshooting

### Component Test Issues

```bash
# Tests not found - ensure proper file naming
ls __tests__/*.test.ts

# Run specific test file
elizaos test component --name specific-test

# Skip automatic build if having compilation issues
elizaos test component --skip-build
```

### E2E Test Issues

```bash
# Port conflicts
elizaos test e2e --port 4000

# Skip automatic build if having issues
elizaos test e2e --skip-build

# Runtime initialization failures
elizaos env list
```

### Build-Related Issues

```bash
# Skip automatic build if having compilation issues
elizaos test --skip-build

# Clear build artifacts and let test rebuild
rm -rf dist/ build/
elizaos test
```

## Related Commands

- [`dev`](./dev.md): Run in development mode with hot reloading
- [`start`](./start.md): Start your project for manual testing
- [`create`](./create.md): Create new projects with test structure
- [`env`](./env.md): Configure environment variables for testing
