/**
 * @fileoverview Test Utilities for X Plugin Tests
 *
 * Uses REAL AgentRuntime instances for testing.
 * Re-exports utilities from bootstrap test-utils.
 */

export {
	cleanupTestRuntime,
	createTestMemory,
	createTestRuntime,
	createTestState,
	createUUID,
} from "../../../../packages/core/src/bootstrap/__tests__/test-utils";
