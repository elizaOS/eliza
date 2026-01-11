# E2E Test Scripts

This directory contains scripts for running end-to-end tests with Cypress.

## Available Scripts

### `test-e2e.js`

The main test runner that starts the Eliza server and runs Cypress tests.

**Usage:**

```bash
npm run test:e2e              # Run with headed browser
npm run test:e2e:headless     # Run headless
```

### `test-e2e-ci.js`

Advanced test runner optimized for CI/CD environments with additional features:

- Better process management
- Configurable via environment variables
- Server output logging
- Graceful cleanup
- CI-friendly output formatting

**Usage:**

```bash
npm run test:e2e:ci           # Run in CI mode
```

## Environment Variables

The CI script supports these environment variables:

| Variable           | Default | Description                            |
| ------------------ | ------- | -------------------------------------- |
| `TEST_SERVER_PORT` | 3000    | Port for the test server               |
| `TEST_MAX_RETRIES` | 60      | Max attempts to connect to server      |
| `TEST_RETRY_DELAY` | 1000    | Delay between connection attempts (ms) |
| `CYPRESS_HEADED`   | true    | Run Cypress in headed mode             |
| `CI`               | false   | Enable CI mode (no colors, timestamps) |
| `VERBOSE`          | true    | Show detailed server output            |

## Examples

```bash
# Run tests on a different port
TEST_SERVER_PORT=4000 npm run test:e2e

# Run with custom retry settings
TEST_MAX_RETRIES=120 TEST_RETRY_DELAY=2000 npm run test:e2e:ci

# Run in quiet mode
VERBOSE=false npm run test:e2e
```

## Features

Both scripts provide:

- ✅ Automatic server startup
- ✅ Health check waiting
- ✅ Proper cleanup on exit
- ✅ Error handling
- ✅ Colored output
- ✅ Process termination handling

The CI script additionally provides:

- ✅ Process group management
- ✅ Server output capture
- ✅ Directory creation
- ✅ Configurable timeouts
- ✅ CI-friendly formatting
