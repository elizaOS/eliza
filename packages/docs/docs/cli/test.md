---
sidebar_position: 6
title: Test Command
description: Run and manage tests for ElizaOS projects and plugins
keywords: [testing, component tests, e2e tests, Vitest, test runner, development]
image: /img/cli.jpg
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Test Command

Run tests for Eliza agent projects and plugins.

<Tabs>
<TabItem value="overview" label="Overview & Options" default>

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
| `--skip-type-check` | Skip TypeScript type checking for faster test runs            |
| `--watch`           | Enable watch mode to re-run tests on file changes             |
| `--coverage`        | Generate a test coverage report                               |

</TabItem>
<TabItem value="examples" label="Examples & Guides">

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

# Generate a test coverage report
elizaos test --coverage

# Run tests in watch mode for continuous development
elizaos test --watch

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

</TabItem>
</Tabs>
