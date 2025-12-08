# Server Tests

Comprehensive test suite for the ElizaOS server package.

## 📊 Test Coverage

**Total: 385 passing tests | 22 skipped**

```
├── unit/            → 155 tests  (Unit tests for individual components)
├── integration/     → 152 tests  (End-to-end integration tests)
├── features/        →  47 tests  (Feature-specific tests)
├── security/        →  36 tests  (Security and RLS tests)
├── compatibility/   →  13 tests  (CLI/API compatibility)
└── test-utils/      →  13 tests  (Test utilities and mocks)
```

## 🗂️ Directory Structure

```
__tests__/
├── unit/                    # Unit tests for isolated components
│   ├── api/                 # API endpoint tests
│   │   ├── agents-runs.test.ts
│   │   └── health-endpoints.test.ts
│   ├── middleware/          # Middleware tests
│   │   ├── auth-middleware.test.ts
│   │   └── middleware.test.ts
│   ├── services/            # Service layer tests
│   │   ├── agent-server.test.ts
│   │   ├── message-bus-compatibility.test.ts
│   │   └── message-bus.test.ts (skipped - timeouts)
│   └── utils/               # Utility function tests
│       ├── client-path-resolution.test.ts
│       ├── file-utils.test.ts
│       ├── loader-uuid.test.ts
│       ├── loader.test.ts
│       ├── port-autodiscovery.test.ts
│       ├── utils.test.ts
│       └── validation.test.ts
│
├── integration/             # Integration tests with real components
│   ├── agent-server-interaction.test.ts
│   ├── bootstrap-autoload.test.ts
│   ├── database-operations.test.ts (skipped - test interference)
│   ├── jobs-message-flow.test.ts
│   └── socketio-message-flow.test.ts
│
├── security/                # Security and access control tests
│   └── rls-server.test.ts  # Row Level Security (RLS) multi-tenant tests
│
├── features/                # Feature-specific tests
│   ├── character-file-size-regression.test.ts
│   ├── server-core.test.ts (rate limiting, middleware patterns, config, UI toggle)
│   ├── socketio-router.test.ts
│   └── ui-toggle.test.ts
│
├── compatibility/           # API/CLI compatibility tests
│   ├── cli-compatibility.test.ts  # Verifies exported API contracts
│   └── cli-patterns.test.ts       # Tests usage patterns
│
└── test-utils/              # Shared test utilities
    ├── environment.ts       # Environment cleanup helpers
    ├── mocks.ts            # Mock factories (runtime, database, etc.)
    └── mocks.test.ts       # Tests for mock utilities
```

## 🏃 Running Tests

```bash
# Run all tests
bun test packages/server/

# Run specific category
bun test packages/server/src/__tests__/unit/
bun test packages/server/src/__tests__/integration/
bun test packages/server/src/__tests__/security/

# Run single file
bun test packages/server/src/__tests__/unit/utils/validation.test.ts

# Watch mode
bun test packages/server/ --watch
```

## 🧪 Test Categories

### Unit Tests (`unit/`)

Test individual components in isolation without external dependencies.

- **API**: HTTP endpoint handlers, request/response formatting
- **Middleware**: Authentication, validation, rate limiting, security
- **Services**: Core business logic (AgentServer, MessageBus)
- **Utils**: Pure functions (path resolution, validation, UUID generation, file handling)

### Integration Tests (`integration/`)

Test interactions between multiple components with real dependencies.

- Agent server lifecycle (startup, registration, shutdown)
- Database operations (CRUD, transactions, integrity)
- Socket.IO message flow (real-time communication)
- Job processing with message bus
- Bootstrap plugin auto-loading

### Security Tests (`security/`)

Test security-critical features and access controls.

- Row Level Security (RLS) multi-tenancy
- Server ID assignment and validation
- Connection pool isolation
- Endpoint security

### Feature Tests (`features/`)

Test complete features end-to-end.

- Character file size limits (regression tests)
- UI enable/disable toggle
- Socket.IO router
- Server core patterns (rate limiting, middleware, configuration)

### Compatibility Tests (`compatibility/`)

Ensure CLI and API compatibility across versions.

- Export structure validation
- Usage pattern verification
- Breaking change detection

## 🛠️ Test Utilities

### Environment Helpers (`test-utils/environment.ts`)

Helpers for test isolation and environment cleanup:

```typescript
import { setupTestEnvironment, teardownTestEnvironment } from './test-utils/environment';

let envSnapshot: EnvironmentSnapshot;

beforeEach(() => {
  envSnapshot = setupTestEnvironment(); // Clean env + clear ElizaPaths cache
});

afterEach(() => {
  teardownTestEnvironment(envSnapshot); // Restore original state
});
```

### Mock Factories (`test-utils/mocks.ts`)

Centralized mocks for common objects:

```typescript
import {
  createMockAgentRuntime,
  createMockDatabaseAdapter,
  createMockExpressRequest,
  createMockExpressResponse,
  createMockSocketIOServer,
  createMockHttpServer,
} from './test-utils/mocks';
```

## ⚠️ Skipped Tests

**22 tests currently skipped:**

| File                          | Reason                                              | Status              |
| ----------------------------- | --------------------------------------------------- | ------------------- |
| `message-bus.test.ts`         | Timeouts due to async event handling complexity     | Known issue         |
| `database-operations.test.ts` | Test interference in full run (passes in isolation) | Needs isolation fix |
| `agents-runs.test.ts`         | Test interference in full run (passes in isolation) | Needs isolation fix |
| Various loader tests          | File system operations cause hangs with Bun         | Known Bun issue     |

## 📝 Writing Tests

### Best Practices

1. **Use test utilities** - Leverage `test-utils/environment.ts` for env cleanup
2. **Isolate tests** - Each test should be independent (use beforeEach/afterEach)
3. **Mock external dependencies** - Use factories from `test-utils/mocks.ts`
4. **Clear descriptive names** - Test names should explain what they verify
5. **Organize by feature** - Group related tests in describe blocks

### Example Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  setupTestEnvironment,
  teardownTestEnvironment,
  type EnvironmentSnapshot,
} from '../test-utils/environment';

describe('Feature Name', () => {
  let envSnapshot: EnvironmentSnapshot;

  beforeEach(() => {
    envSnapshot = setupTestEnvironment();
  });

  afterEach(() => {
    teardownTestEnvironment(envSnapshot);
  });

  describe('Specific Functionality', () => {
    it('should do something specific', () => {
      // Arrange
      const input = 'test-value';

      // Act
      const result = functionUnderTest(input);

      // Assert
      expect(result).toBe('expected-value');
    });
  });
});
```

## 🔧 Troubleshooting

### Tests Failing After Moving Files

If you move test files, update relative imports:

```typescript
// Before (in __tests__/):
import { AgentServer } from '../index';

// After (in __tests__/unit/services/):
import { AgentServer } from '../../../index';
```

### Test Isolation Issues

If tests pass individually but fail in suite:

1. Check for environment variable pollution
2. Ensure `clearCache()` is called in cleanup
3. Verify database/server cleanup in `afterEach`

### Import Errors

Common import path patterns:

| Location           | Import Server Code | Import Test Utils   |
| ------------------ | ------------------ | ------------------- |
| `unit/utils/`      | `../../../`        | `../../test-utils/` |
| `unit/middleware/` | `../../../`        | `../../test-utils/` |
| `integration/`     | `../../`           | `../test-utils/`    |
| `features/`        | `../../`           | `../test-utils/`    |

## 📚 Additional Resources

- [Bun Test Documentation](https://bun.sh/docs/cli/test)
- [ElizaOS Core Testing Guide](../../../core/__tests__/README.md)
- [Server Architecture](../README.md)

---

**Last Updated:** 2025-11-20
**Test Framework:** Bun Test
**Coverage Target:** >80% for critical paths
