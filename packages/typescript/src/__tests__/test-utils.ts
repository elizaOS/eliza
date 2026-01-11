/**
 * @fileoverview Test Utilities for Packages TypeScript Tests
 *
 * Creates REAL AgentRuntime instances for testing.
 * Re-exports from bootstrap test-utils for consistency.
 */

// Re-export all test utilities from bootstrap test-utils
export {
  cleanupTestRuntime,
  createTestCharacter,
  createTestDatabaseAdapter,
  createTestMemory,
  createTestRuntime,
  createTestState,
  createUUID,
  DEFAULT_TEST_CHARACTER,
  stringToUuid,
} from "../bootstrap/__tests__/test-utils";
