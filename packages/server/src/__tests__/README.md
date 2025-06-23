# Server Package Test Guide

This directory contains all tests for the `@elizaos/server` package.

## Test Structure

```
__tests__/
├── setup.ts              # Global test setup (preloaded by Bun)
├── test-runner.ts        # Custom test runner for proper isolation
├── integration/          # Integration tests (require real server/DB)
│   ├── agent-server-interaction.test.ts
│   ├── database-operations.test.ts
│   └── socketio-message-flow.test.ts
├── test-utils/           # Shared test utilities
└── *.test.ts            # Unit tests (use mocks)
```

## Running Tests

The server package uses a custom test runner to ensure proper test isolation:

```bash
# Run unit tests only (default)
bun run test

# Run unit tests explicitly
bun run test:unit

# Run integration tests only
bun run test:integration

# Run all tests
bun run test:all

# Run tests with coverage
bun run test:coverage

# Watch mode for development
bun run test:watch
```

## Test Types

### Unit Tests
- Located in `src/__tests__/*.test.ts` (excluding integration/)
- Use mocks for all external dependencies
- Do not require a running server or database
- Fast execution
- Test individual components in isolation

### Integration Tests
- Located in `src/__tests__/integration/*.test.ts`
- Use real database connections (PGLite)
- Create actual server instances
- Test end-to-end workflows
- Slower execution but more comprehensive

## Test Setup

The `setup.ts` file is automatically loaded before all tests and:
- Configures test environment variables
- Suppresses console output (unless debugging)
- Creates test database directories
- Provides utilities for test database management
- Cleans up resources after tests complete

## Test Database Management

Integration tests use temporary PGLite databases:
- Each test suite gets its own database instance
- Databases are created in `.eliza/test-db/`
- Automatic cleanup after tests complete
- No interference between test runs

## Writing Tests

### Unit Test Example
```typescript
import { describe, it, expect, mock, jest } from 'bun:test';
import { myFunction } from '../myModule';

// Mock external dependencies
mock.module('@elizaos/core', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
  }
}));

describe('myFunction', () => {
  it('should work correctly', () => {
    const result = myFunction('test');
    expect(result).toBe('expected');
  });
});
```

### Integration Test Example
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { AgentServer } from '../../index';
import { getTestDbPath } from '../setup';

describe('Integration: Server Operations', () => {
  let server: AgentServer;
  let testDbPath: string;

  beforeAll(async () => {
    testDbPath = getTestDbPath();
    server = new AgentServer();
    await server.initialize({ dataDir: testDbPath });
  });

  afterAll(async () => {
    await server.stop();
    // Cleanup handled by setup.ts
  });

  it('should perform real operations', async () => {
    // Test with real server instance
  });
});
```

## Debugging Tests

To debug hanging tests:

1. **Check if it's a unit or integration test**
   - Unit tests should not depend on external services
   - Integration tests may need more time/resources

2. **Enable console output**
   ```typescript
   // Temporarily comment out console suppression in setup.ts
   // console.log = () => {};
   ```

3. **Run specific test file**
   ```bash
   bun test src/__tests__/specific-test.test.ts
   ```

4. **Check for async issues**
   - Ensure all promises are awaited
   - Check for proper cleanup in afterEach/afterAll

5. **Increase timeout for slow operations**
   ```typescript
   it('slow test', async () => {
     // test code
   }, 30000); // 30 second timeout
   ```

## Common Issues

### Tests Hanging
- Usually caused by unclosed database connections
- Missing `await` on async operations
- Server not properly stopped in cleanup

### Port Conflicts
- Integration tests use ephemeral ports
- Ensure no hardcoded ports in tests

### Database Errors
- Check if test database directory has proper permissions
- Ensure cleanup runs between test suites

## Best Practices

1. **Keep unit tests fast** - Mock all external dependencies
2. **Integration tests should be self-contained** - Create and destroy all resources
3. **Use descriptive test names** - Should explain what is being tested
4. **Clean up resources** - Always clean up in afterEach/afterAll
5. **Avoid hardcoded values** - Use constants or generate unique values
6. **Test error cases** - Don't just test happy paths

## Continuous Integration

The CI pipeline runs tests in this order:
1. Unit tests first (fail fast on basic issues)
2. Integration tests if unit tests pass
3. Coverage report generation

This ensures quick feedback while maintaining comprehensive testing.
