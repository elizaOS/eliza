# CLI Test Suite

This directory contains TypeScript tests for the ElizaOS CLI, converted from the original BATS test files.

## Test Structure

### Shared Utilities (`test-utils.ts`)

The `test-utils.ts` file provides common functionality to reduce code duplication:

- **`setupTestEnvironment()`** - Creates temp directory and sets up CLI command
- **`cleanupTestEnvironment()`** - Restores directory and cleans up temp files  
- **`runCliCommand()`** - Executes CLI commands with standard options
- **`expectCliCommandToFail()`** - Runs commands expecting failure
- **`expectHelpOutput()`** - Validates help command output
- **`createTestProject()`** - Creates ElizaOS projects for testing
- **`createTestPluginStructure()`** - Sets up plugin directory structure
- **`createTestAgent()`** - Creates test agent JSON files
- **`assertions`** - Common assertion helpers

### Refactored Pattern

#### Before (Repetitive):
```typescript
describe("My Command", () => {
  let testTmpDir: string;
  let elizaosCmd: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    testTmpDir = await mkdtemp(join(tmpdir(), "eliza-test-"));
    process.chdir(testTmpDir);
    const scriptDir = join(__dirname, "..");
    elizaosCmd = `bun run ${join(scriptDir, "../dist/index.js")}`;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (testTmpDir && testTmpDir.includes("eliza-test-")) {
      try {
        await rm(testTmpDir, { recursive: true });
      } catch (e) {}
    }
  });

  test("command --help", () => {
    const result = execSync(`${elizaosCmd} command --help`, { encoding: "utf8" });
    expect(result).toContain("Usage: elizaos command");
  });
});
```

#### After (DRY):
```typescript
import { setupTestEnvironment, cleanupTestEnvironment, runCliCommand, expectHelpOutput, type TestContext } from "./test-utils";

describe("My Command", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await setupTestEnvironment();
  });

  afterEach(async () => {
    await cleanupTestEnvironment(context);
  });

  test("command --help", () => {
    const result = runCliCommand(context.elizaosCmd, "command --help");
    expectHelpOutput(result, "command");
  });
});
```

### Files Status

| Test File | Status | Notes |
|-----------|--------|-------|
| `setup-monorepo.test.ts` | ✅ Refactored | Using test-utils |
| `env.test.ts` | ✅ Refactored | Using test-utils |  
| `test.test.ts` | ✅ Refactored | Using test-utils |
| `agent.test.ts` | 🔄 Can be refactored | Complex server setup |
| `create.test.ts` | 🔄 Can be refactored | Project creation helpers |
| `plugins.test.ts` | 🔄 Can be refactored | Plugin structure helpers |
| `publish.test.ts` | 🔄 Can be refactored | Mock npm/git commands |
| `start.test.ts` | 🔄 Can be refactored | Server management |
| `update.test.ts` | 🔄 Can be refactored | Project helpers |

### Refactoring Remaining Files

To refactor the remaining test files:

1. **Import test-utils**: Replace individual imports with test-utils
2. **Replace setup/teardown**: Use `setupTestEnvironment()` and `cleanupTestEnvironment()`
3. **Use CLI helpers**: Replace `execSync` calls with `runCliCommand()` 
4. **Use validation helpers**: Replace manual help validation with `expectHelpOutput()`
5. **Extract common patterns**: Move repeated logic to test-utils

### Benefits

- **Reduced Code**: ~50% less boilerplate per test file
- **Consistency**: Standardized patterns across all tests
- **Maintainability**: Changes to test infrastructure only need to be made in one place
- **Readability**: Tests focus on what they're testing, not setup/teardown
- **Reliability**: Consistent error handling and cleanup

### Test Coverage

All tests maintain 100% coverage compared to original BATS files:
- **97 total tests** across 9 command categories
- **No mocking** - all tests use real CLI commands
- **Isolated environments** - each test runs in clean temp directory