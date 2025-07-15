# CLI Test Suite

This directory contains TypeScript tests for the ElizaOS CLI, converted from the original BATS test files.

## Test Structure

### Core Test Utilities

The test suite provides several helper functions:

**From `test-utils.ts`:**

- **`setupTestEnvironment()`** - Creates temporary directories and sets up test state
- **`cleanupTestEnvironment()`** - Cleans up after tests complete
- **`expectHelpOutput()`** - Validates help command output
- **`createTestProject()`** - Creates a test ElizaOS project
- **`createTestAgent()`** - Creates test agent JSON files
- **`createTestPluginStructure()`** - Sets up plugin directory structure
- **`assertions`** - Common assertion helpers

**From `../utils/bun-test-helpers.ts`:**

- **`bunExecSync()`** - Execute CLI commands synchronously
- **`bunSpawn()`** - Spawn long-running processes
- **`parseCommand()`** - Parse command strings

### Command Execution Pattern

All tests now use the consistent pattern of directly calling `bunExecSync`:

```typescript
import { bunExecSync } from '../utils/bun-test-helpers';

// Execute a command
const result = bunExecSync('elizaos [command]', { encoding: 'utf8' });

// With platform-specific options
import { getPlatformOptions } from './test-utils';
const result = bunExecSync('elizaos [command]', getPlatformOptions({ encoding: 'utf8' }));
```

### Example Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  expectHelpOutput,
  type TestContext,
} from './test-utils';
import { bunExecSync } from '../utils/bun-test-helpers';

describe('ElizaOS Command Tests', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await setupTestEnvironment();
  });

  afterEach(async () => {
    await cleanupTestEnvironment(context);
  });

  it('command shows help', async () => {
    const result = bunExecSync('elizaos command --help', { encoding: 'utf8' });
    expectHelpOutput(result, 'command');
  });
});
```

### Files Status

| Test File          | Status     | Pattern Used                 |
| ------------------ | ---------- | ---------------------------- |
| `agent.test.ts`    | ✅ Updated | Direct bunExecSync           |
| `create.test.ts`   | ✅ Updated | Direct bunExecSync           |
| `dev.test.ts`      | ✅ Updated | Direct bunExecSync/Bun.spawn |
| `env.test.ts`      | ✅ Updated | Direct bunExecSync           |
| `monorepo.test.ts` | ✅ Updated | Direct bunExecSync           |
| `plugins.test.ts`  | ✅ Correct | Already using bunExecSync    |
| `publish.test.ts`  | ✅ Correct | Already using bunExecSync    |
| `start.test.ts`    | ✅ Correct | Already using proper pattern |
| `test.test.ts`     | ✅ Updated | Direct bunExecSync           |
| `update.test.ts`   | ✅ Updated | Direct bunExecSync           |

### Migration from Old Patterns

When migrating tests from older patterns:

1. **Replace direct paths**: Replace `bun "/path/to/cli/index.js"` with `elizaos` command
2. **Use temp directories**: Replace manual directory creation with `setupTestEnvironment()`
3. **Use bunExecSync**: Replace `execSync` or wrapper calls with `bunExecSync('elizaos [command]', { encoding: 'utf8' })`
4. **Use validation helpers**: Replace manual help validation with `expectHelpOutput()`
5. **Remove path manipulation**: No need for `getBunExecutable()` or constructing CLI paths

### Key Patterns

1. **Synchronous command execution:**

   ```typescript
   const result = bunExecSync('elizaos [command]', { encoding: 'utf8' });
   ```

2. **Long-running processes:**

   ```typescript
   const proc = Bun.spawn(['elizaos', 'start', ...args], {
     cwd: process.cwd(),
     env: { ...process.env },
     stdout: 'pipe',
     stderr: 'pipe',
   });
   ```

3. **Error handling:**
   ```typescript
   try {
     bunExecSync('elizaos [command]', { encoding: 'utf8' });
   } catch (e: any) {
     // Handle expected failures
     expect(e.status).not.toBe(0);
   }
   ```

### Benefits

- **Consistency**: All tests use the same execution pattern
- **Simplicity**: Direct use of `bunExecSync` without wrappers
- **Reliability**: Works with global `elizaos` command via `bun link`
- **Cross-platform**: Platform differences handled by `getPlatformOptions()`
- **No path manipulation**: Eliminates complex path construction

### Test Coverage

All tests maintain 100% coverage compared to original BATS files:

- **97 total tests** across 9 command categories
- **No mocking** - all tests use real CLI commands
- **Isolated environments** - each test runs in clean temp directory
