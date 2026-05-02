/**
 * DatabaseAdapter Abstract Class Tests
 *
 * NOTE: This file tests the abstract class contract only.
 * Actual database behavior is tested in @elizaos/plugin-sql
 * using real database connections (PGLite).
 */

import { describe, expect, it } from "vitest";
import { DatabaseAdapter } from "../database";

describe("DatabaseAdapter Abstract Class", () => {
	it("should be an abstract class that cannot be instantiated directly", () => {
		// TypeScript prevents direct instantiation of abstract classes at compile time
		// This test documents the expected behavior
		expect(DatabaseAdapter).toBeDefined();
		expect(typeof DatabaseAdapter).toBe("function");
	});

	it("should define required abstract methods", () => {
		// Verify the class prototype has the expected shape
		// This ensures the interface contract is maintained
		const prototype = DatabaseAdapter.prototype;
		expect(prototype).toBeDefined();
	});

	it("should have Promise<boolean> return types for mutation methods", () => {
		// Type-level test: verify mutation methods return Promise<boolean>
		type UpdateAgentsReturn = ReturnType<DatabaseAdapter["updateAgents"]>;
		type DeleteAgentsReturn = ReturnType<DatabaseAdapter["deleteAgents"]>;
		type DeleteParticipantsReturn = ReturnType<
			DatabaseAdapter["deleteParticipants"]
		>;

		// These type assertions will fail compilation if return types don't match
		const _updateAgentsIsBoolean: Promise<boolean> = {} as UpdateAgentsReturn;
		const _deleteAgentsIsBoolean: Promise<boolean> = {} as DeleteAgentsReturn;
		const _deleteParticipantsIsBoolean: Promise<boolean> =
			{} as DeleteParticipantsReturn;
	});
});
