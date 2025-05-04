# Plugin Registry Testing

This directory contains tests for the plugin registry and publishing system.

## Test Structure

- `fixtures/` - Test data used by the test suite
- `plugin-publisher.test.js` - Tests for the plugin-publisher utility
- `plugin-command.test.js` - Tests for the plugin CLI command
- `publish-plugins.test.js` - Tests for the batch publishing script
- `manual-test.js` - Manual test script for interactive testing
- `setup.js` - Common test setup

## Running Tests

```bash
# Run all tests
npm run test:registry

# Run specific test suites
npm run test:publisher
npm run test:plugin-command
npm run test:publish-plugins

# Run manual test
node test/manual-test.js
```

## Manual Testing

The `manual-test.js` script provides a way to test the plugin publishing workflow with a real plugin. It:

1. Creates a test plugin in `.test-plugin/`
2. Sets up a minimal package.json with required fields
3. Runs the publish command with the `--test` flag (dry run)

This allows for interactive testing without affecting any real repositories.

## Test Coverage

The tests verify:

1. Metadata creation and update in V2 format
2. Platform compatibility settings
3. Index.json V2 integration
4. CLI command options
5. Batch publishing functionality

## Adding New Tests

When adding new tests, follow these guidelines:

1. Create test fixtures in the `fixtures/` directory
2. Use mocking to avoid external dependencies
3. Verify both success and failure paths
4. Test all important parameters and options

## Configuring Jest

The Jest configuration is in both `jest.config.js` and `package.json`. The configuration:

1. Sets up Node.js environment
2. Maps module paths
3. Configures code coverage
4. Sets up test matching patterns
