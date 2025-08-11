# Polygon Plugin Test Suite

This directory contains standardized tests for the Polygon Plugin. All tests follow a consistent structure and use the centralized mocks defined in `vitest.setup.ts`.

## Test Directory Structure

```
tests/
├── actions/             # Tests for action handlers
│   ├── delegateL1.test.ts
│   ├── getDelegatorInfo.test.ts
│   ├── getValidatorInfo.test.ts
│   ├── restakeRewardsL1.test.ts
│   ├── undelegateL1.test.ts
│   └── withdrawRewardsL1.test.ts
├── providers/           # Tests for providers
│   ├── PolygonRpcInteractions.test.ts
│   └── PolygonWalletProvider.test.ts
├── services/            # Tests for services
│   ├── PolygonBridgeService.test.ts
│   └── PolygonRpcService.test.ts
├── unit/                # Smaller unit tests
│   ├── mocks/
│   ├── PolygonRpcProvider.test.ts
│   ├── PolygonWalletProvider.test.ts
│   ├── PolygonRpcInteractions.test.ts
│   └── PolygonBridgeService.test.ts
├── integration/         # Integration tests
│   └── plugin-integration.test.ts
└── test-helpers.ts      # Common test utilities
```

## Test Helpers

The `test-helpers.ts` file provides common utilities for all tests, including:

- `createMockMessage`: Creates standard mock messages
- `createMockState`: Creates standard mock state objects
- `createMockCallback`: Creates standard callback functions
- `setupPolygonServiceMethod`: Sets up specific service methods with custom returns
- `resetCommonMocks`: Resets all common mocks

## Mocks

Common mocks are defined in the root `vitest.setup.ts` file. These include:

- Contract mocks (RootChainManager, StakeManager, ValidatorShare, etc.)
- Service mocks (PolygonRpcService, etc.)
- ElizaOS runtime mock
- Ethers and Viem mocks

## Writing Tests

When writing new tests, follow these guidelines:

1. **Use the standardized structure** in existing tests
2. **Import the central mocks** from `vitest.setup.ts`
3. **Use test helpers** for common test operations
4. **Separate tests logically** by behavior

Example:

```typescript
import { mockRuntime, mockPolygonRpcService } from '../../vitest.setup';
import { createMockMessage, createMockCallback, resetCommonMocks } from '../test-helpers';

describe('MyFeature', () => {
  beforeEach(() => {
    resetCommonMocks();
    // Setup specific mocks
  });

  describe('specific behavior', () => {
    it('should do something specific', async () => {
      // Test the specific behavior
    });
  });
});
```

## Standardization Status

| Component Type | Status      | Notes                                                               |
| -------------- | ----------- | ------------------------------------------------------------------- |
| Actions        | ✅ Complete | All action tests have been standardized                             |
| Services       | ✅ Complete | PolygonRpcService, BridgeService, and GasService tests standardized |
| Providers      | ✅ Complete | PolygonWalletProvider tests standardized                            |
| Unit Tests     | ✅ Complete | Unit tests organized and standardized                               |
| Integration    | ✅ Complete | Plugin & PolygonRpcService integration tests standardized           |

## Known Issues

1. The tests require `@elizaos/core` package, which may need to be installed separately.
2. Some tests may fail due to missing dependencies when running with `npm test`.

## Running Tests

Tests can be run individually using:

```bash
npx vitest run tests/actions/delegateL1.test.ts
```

## Adding New Tests

1. Create a new file in the appropriate directory
2. Follow the existing pattern for similar tests
3. Use the centralized mocks and helpers
4. Add descriptive test names that explain what is being tested

## Migrated Tests

All tests have been migrated from the previous structure in `src/__tests__/` to this standardized approach. The old tests are deprecated and marked with `@deprecated` tags and will be removed in a future update.
