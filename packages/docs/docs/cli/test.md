---
sidebar_position: 6
title: Test Command
description: Run and manage tests for ElizaOS projects and plugins
keywords: [testing, unit tests, integration tests, Jest, test runner, development]
image: /img/cli.jpg
---

# Test Command

The `test` command allows you to run tests for your ElizaOS projects, plugins, and agents. It helps ensure your implementations work correctly before deployment.

## Usage

```bash
npx @elizaos/cli test [options]
```

## Options

| Option             | Description                                            |
| ------------------ | ------------------------------------------------------ |
| `--project`, `-p`  | Path to project directory (default: current directory) |
| `--file`, `-f`     | Specific test file to run                              |
| `--suite`          | Specific test suite to run                             |
| `--test`, `-t`     | Specific test to run                                   |
| `--watch`, `-w`    | Watch files and rerun tests on changes                 |
| `--verbose`        | Show detailed test output                              |
| `--json`           | Output results in JSON format                          |
| `--timeout`        | Timeout in milliseconds for each test (default: 5000)  |
| `--fail-fast`      | Stop after first test failure                          |
| `--no-compilation` | Skip TypeScript compilation                            |
| `--config`, `-c`   | Path to test configuration file                        |

## Test Structure

ElizaOS tests are organized in three levels:

1. **Test Files**: Physical files containing test suites
2. **Test Suites**: Groups of related tests with a unique name
3. **Tests**: Individual test cases that verify specific functionality

Tests are defined in plugins or projects using a structured format:

```typescript
// Example test structure from a plugin
const tests = [
  {
    name: 'plugin_test_suite',
    tests: [
      {
        name: 'example_test',
        fn: async (runtime) => {
          // Test implementation
          if (runtime.character.name !== 'Eliza') {
            throw new Error('Expected character name to be "Eliza"');
          }
        },
      },
      {
        name: 'should_have_action',
        fn: async (runtime) => {
          // Another test
          const actionExists = plugin.actions.some((a) => a.name === 'EXAMPLE_ACTION');
          if (!actionExists) {
            throw new Error('Example action not found in plugin');
          }
        },
      },
    ],
  },
];
```

## Running Tests

### Basic Test Execution

Run all tests in the current project:

```bash
# Navigate to your project
cd my-agent-project

# Run all tests
npx @elizaos/cli test
```

### Running Specific Tests

Target specific test suites or individual tests:

```bash
# Run a specific test suite
npx @elizaos/cli test --suite plugin_test_suite

# Run a specific test
npx @elizaos/cli test --suite plugin_test_suite --test example_test

# Run tests from a specific file
npx @elizaos/cli test --file src/tests/agent.test.ts
```

### Watch Mode

Automatically rerun tests when files change:

```bash
npx @elizaos/cli test --watch
```

## Test Output

The test command produces output showing test results:

```
PASS  Test Suite: plugin_test_suite (2 tests)
  ✓ example_test (15ms)
  ✓ should_have_action (3ms)

FAIL  Test Suite: agent_test_suite (3 tests)
  ✓ agent_initialization (20ms)
  ✓ message_processing (45ms)
  ✗ knowledge_retrieval (30ms)
    Error: Expected 3 knowledge items but got 2

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 4 passed, 5 total
Time:        1.5s
```

## Writing Tests

### Project Tests

Project tests typically verify agent behavior, knowledge retrieval, and integration with plugins:

```typescript
// Example project test
export default {
  name: 'agent_behavior_tests',
  tests: [
    {
      name: 'responds_to_greeting',
      fn: async (runtime) => {
        const agent = runtime.getAgent('assistant');
        const response = await agent.processMessage({
          content: { text: 'Hello' },
          userId: 'test-user',
        });

        if (!response.content.text.includes('hello') && !response.content.text.includes('Hi')) {
          throw new Error('Agent did not respond to greeting properly');
        }
      },
    },
  ],
};
```

### Plugin Tests

Plugin tests verify the functionality of actions, services, and providers:

```typescript
// Example plugin test
export const testSuite = {
  name: 'discord_plugin_tests',
  tests: [
    {
      name: 'registers_discord_service',
      fn: async (runtime) => {
        const service = runtime.getService('discord');
        if (!service) {
          throw new Error('Discord service not registered');
        }
      },
    },
    {
      name: 'handles_discord_messages',
      fn: async (runtime) => {
        // Test implementation
      },
    },
  ],
};
```

## Test Hooks

ElizaOS tests support hooks for setup and teardown:

```typescript
export default {
  name: 'database_tests',
  beforeAll: async (runtime) => {
    // Setup test database
    await runtime.db.migrate();
  },
  afterAll: async (runtime) => {
    // Clean up test database
    await runtime.db.clean();
  },
  beforeEach: async (runtime, test) => {
    // Setup before each test
    console.log(`Running test: ${test.name}`);
  },
  afterEach: async (runtime, test) => {
    // Cleanup after each test
  },
  tests: [
    // Test cases
  ],
};
```

## Test Assertions

Tests should make assertions to verify behavior:

```typescript
test('check_knowledge_retrieval', async (runtime) => {
  const query = 'What is our refund policy?';
  const results = await runtime.knowledge.search(query);

  // Check count
  if (results.length === 0) {
    throw new Error('No knowledge results found');
  }

  // Check relevance
  if (!results[0].text.includes('refund') && !results[0].text.includes('return')) {
    throw new Error('Knowledge results not relevant to query');
  }
});
```

## Examples

### Testing a Complete Project

```bash
# Run all tests
npx @elizaos/cli test

# Run with detailed output
npx @elizaos/cli test --verbose
```

### Testing During Development

```bash
# Watch for changes and automatically rerun tests
npx @elizaos/cli test --watch

# Focus on a specific test while debugging
npx @elizaos/cli test --suite agent_suite --test message_handling --watch
```

### CI/CD Integration

```bash
# Run tests in CI environment
npx @elizaos/cli test --json > test-results.json
```

## Troubleshooting

### Tests not found

If tests aren't being discovered:

```bash
# Check test discovery with verbose logging
npx @elizaos/cli test --verbose

# Try specifying the test file directly
npx @elizaos/cli test --file src/tests/main.test.ts
```

### Tests timing out

For long-running tests:

```bash
# Increase test timeout
npx @elizaos/cli test --timeout 10000
```

### TypeScript errors

If TypeScript compilation is failing:

```bash
# Build the project first
npx @elizaos/cli project build

# Then run tests without recompilation
npx @elizaos/cli test --no-compilation
```

## Related Commands

- [`dev`](./dev.md): Run your project in development mode
- [`start`](./start.md): Start your project in production mode
- [`project`](./projects.md): Manage project configuration
