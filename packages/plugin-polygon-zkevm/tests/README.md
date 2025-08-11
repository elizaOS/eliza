# Polygon zkEVM Plugin Test Suite

This directory contains standardized tests for the Polygon zkEVM Plugin. All tests follow a consistent structure and use the centralized mocks defined in `vitest.setup.ts`.

## Test Directory Structure

```
tests/
├── actions/             # Tests for action handlers
│   ├── getCurrentBlockNumber.test.ts
│   ├── getBalance.test.ts
│   ├── getTransactionDetails.test.ts
│   ├── getAccountBalance.test.ts
│   ├── getGasPriceEstimates.test.ts
│   ├── checkBlockStatus.test.ts
│   ├── getBatchInfo.test.ts
│   ├── getLogs.test.ts
│   └── getCode.test.ts
├── unit/                # Unit tests for core functionality
│   ├── mocks/
│   ├── zkevmProvider.test.ts
│   ├── alchemyIntegration.test.ts
│   └── blockNumberParsing.test.ts
├── integration/         # Integration tests
│   ├── plugin-integration.test.ts
│   └── alchemy-api.test.ts
└── test-helpers.ts      # Common test utilities
```

## Test Helpers

The `test-helpers.ts` file provides common utilities for all tests, including:

- `createMockMessage`: Creates standard mock messages for zkEVM queries
- `createMockState`: Creates standard mock state objects
- `createMockCallback`: Creates standard callback functions
- `createMockRuntime`: Creates mock runtime with zkEVM configuration
- `resetCommonMocks`: Resets all common mocks

## Mocks

Common mocks are defined in the root `vitest.setup.ts` file. These include:

- Alchemy API mocks
- JsonRpcProvider mocks
- ElizaOS runtime mock with zkEVM settings
- Ethers provider mocks

## zkEVM Specific Features

This test suite covers zkEVM-specific functionality:

- **Dual API Strategy**: Tests both Alchemy and JSON-RPC fallback
- **Block Status Mapping**: Tests virtual/trusted/consolidated status
- **Batch Operations**: Tests zkEVM batch information retrieval
- **Hex Conversion**: Tests proper block number formatting
- **Gas Estimation**: Tests zkEVM-specific gas calculations

## Writing Tests

When writing new tests, follow these guidelines:

1. **Use the standardized structure** in existing tests
2. **Import the central mocks** from `vitest.setup.ts`
3. **Use test helpers** for common test operations
4. **Test both Alchemy and RPC fallback** where applicable
5. **Include zkEVM-specific scenarios**

Example:

```typescript
import { mockRuntime, mockAlchemyProvider } from '../../vitest.setup';
import { createMockMessage, createMockCallback, resetCommonMocks } from '../test-helpers';

describe('zkEVM Action', () => {
  beforeEach(() => {
    resetCommonMocks();
    // Setup zkEVM specific mocks
  });

  describe('with Alchemy API', () => {
    it('should handle zkEVM queries correctly', async () => {
      // Test Alchemy integration
    });
  });

  describe('with RPC fallback', () => {
    it('should fallback to JSON-RPC when Alchemy fails', async () => {
      // Test fallback behavior
    });
  });
});
```

## Standardization Status

| Component Type | Status         | Notes                                                    |
| -------------- | -------------- | -------------------------------------------------------- |
| Actions        | 🔄 In Progress | Core actions standardized, remaining actions in progress |
| Unit Tests     | 🔄 In Progress | Provider and utility tests being standardized            |
| Integration    | 🔄 In Progress | API integration tests being developed                    |

## Running Tests

Tests can be run individually using:

```bash
npx vitest run tests/actions/getCurrentBlockNumber.test.ts
```

Or run all tests:

```bash
npm test
```

## zkEVM Test Coverage

- ✅ Block number retrieval and formatting
- ✅ Balance queries (ETH and tokens)
- ✅ Transaction details and receipts
- ✅ Gas price estimation
- ✅ Event logs with proper block filtering
- ✅ Block status checking
- ✅ Batch information retrieval
- ✅ Contract code and storage access
- ✅ Dual API strategy (Alchemy + RPC)

## Environment Requirements

Tests require the following environment variables:

- `ALCHEMY_API_KEY` (for Alchemy API tests)
- `ZKEVM_RPC_URL` (for RPC fallback tests)

## Known Issues

1. Some tests may require network access for integration testing
2. Alchemy API rate limits may affect test execution
3. Block numbers in tests may become outdated over time

## Migration Notes

This test suite replaces the previous ad-hoc test files:

- `test-all-actions.js` → Migrated to structured action tests
- `test-alchemy-*.js` → Migrated to integration tests
- `test-*-validation.js` → Migrated to unit tests
- Various debug files → Removed as redundant
