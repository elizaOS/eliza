# Auto-Trader Plugin Scripts

This directory contains utility scripts for the auto-trader plugin.

## Available Scripts

### test-scenarios.ts
Lists all available test scenarios in the plugin and provides instructions on how to run them.

**Usage:**
```bash
bun run scripts/test-scenarios.ts
```

**Purpose:**
- Discover available test suites
- Learn how to run specific tests
- Quick reference for test commands

## Removed Scripts

The following scripts were removed as they are no longer needed:

- **fix-imports.ts** - All imports in the codebase already use `.js` extensions
- **run-mock-tests.ts** - Use `elizaos test` command instead

## Running Tests

The recommended way to run tests is through the ElizaOS CLI:

```bash
# Run all tests
elizaos test

# Run specific test suite
elizaos test --name "Mock Trading Scenarios"

# Run only E2E tests
elizaos test --e2e

# Run only unit tests
bun test
``` 