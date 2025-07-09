# ElizaOS E2E Test Runner - Pino Error Fix

## Problem

When running `elizaos test` command, the E2E test runner encounters a pino
logging error:

```
TypeError: this[writeSym] is not a function
    at Object.LOG (/Users/.../.bun/install/global/node_modules/pino/lib/tools.js:62:21)
```

This error occurs because the server package has code that directly accesses
pino internals for log streaming features, but in the test environment, pino's
write stream isn't properly initialized.

## Root Cause

The issue stems from:

1. The server package's logging functionality trying to access pino internals
   like `Symbol.for('pino-destination')`
2. The E2E test environment not properly initializing pino's write stream
3. A mismatch between the global CLI version and the local core package version

## Solution

### 1. Add Environment Variable to Disable Log Streaming

In `packages/cli/src/commands/test/actions/e2e-tests.ts`, add the following
environment variable before server initialization:

```typescript
// Disable pino logger features that cause issues in test environment
process.env.DISABLE_LOG_STREAMING = 'true';
process.env.LOG_JSON_FORMAT = 'false';
```

### 2. Update Server Code to Respect the Flag

In `packages/server/src/api/index.ts`, wrap the setupLogStreaming call:

```typescript
// Setup log streaming integration with the logger - but only if not disabled
if (process.env.DISABLE_LOG_STREAMING !== 'true') {
  setupLogStreaming(io, router);
}
```

### 3. Update Logging Endpoints

In `packages/server/src/api/runtime/logging.ts`, add checks for the disabled
state:

```typescript
// Check if log streaming is disabled
if (process.env.DISABLE_LOG_STREAMING === 'true') {
  return res.status(200).json({
    logs: [],
    count: 0,
    total: 0,
    message: 'Log streaming is disabled in test mode',
  });
}
```

## Alternative Workaround

If you cannot modify the CLI package, you can run E2E tests directly using a
test harness:

```typescript
// test-e2e-harness.ts
import { AgentRuntime, asUUID } from '@elizaos/core';
import { createAdaptiveDatabaseAdapterV2 } from '@elizaos/plugin-sql';
import { formsPlugin } from './src/index';
import FormsPluginTestSuite from './src/__tests__/e2e/forms-plugin.test';

// Disable log streaming to avoid pino issues
process.env.DISABLE_LOG_STREAMING = 'true';

// ... create runtime and run tests
```

## Long-term Solution

The proper long-term fix would be to:

1. Update the global `@elizaos/cli` package to include these environment
   variable checks
2. Consider refactoring the logging system to not directly access pino internals
3. Ensure test environments properly initialize all logging infrastructure

## Impact

This fix:

- Allows E2E tests to run without pino errors
- Disables log streaming features only in test mode
- Does not affect production functionality
- Maintains backward compatibility
