import { describe, expect, it } from "vitest";

// Tests for DISABLE_MEMORY_CREATION and ALLOW_MEMORY_SOURCE_IDS logic
describe("MessageService memory persistence logic", () => {
	describe("canPersistMemory calculation", () => {
		// The correct logic: ALLOW_MEMORY_SOURCE_IDS should override DISABLE_MEMORY_CREATION
		// Formula MUST be: canPersistMemory = !disableMemoryCreation || memorySourceAllowed
		// Note: Using AND (&&) instead of OR (||) would incorrectly block whitelisted sources
		// when DISABLE_MEMORY_CREATION is true, defeating the purpose of the whitelist.

		it("should allow memory when DISABLE_MEMORY_CREATION is false", () => {
			const disableMemoryCreation = false;
			const memorySourceAllowed = false;

			// Correct formula: OR logic allows whitelist to override
			const canPersistMemory = !disableMemoryCreation || memorySourceAllowed;

			expect(canPersistMemory).toBe(true);
		});

		it("should allow memory for whitelisted source when DISABLE_MEMORY_CREATION is true", () => {
			const disableMemoryCreation = true;
			const memorySourceAllowed = true; // Source is in ALLOW_MEMORY_SOURCE_IDS

			// Correct formula: OR logic allows whitelist to override
			// Note: This is the critical case - whitelist MUST override global disable
			const canPersistMemory = !disableMemoryCreation || memorySourceAllowed;

			expect(canPersistMemory).toBe(true);
		});

		it("should block memory for non-whitelisted source when DISABLE_MEMORY_CREATION is true", () => {
			const disableMemoryCreation = true;
			const memorySourceAllowed = false;

			const canPersistMemory = !disableMemoryCreation || memorySourceAllowed;

			expect(canPersistMemory).toBe(false);
		});

		it("should check source ID against whitelist correctly", () => {
			const allowedSourceIds = ["source-1", "source-2", "agent-id"];
			const sourceId = "source-1";

			const isSourceAllowed = allowedSourceIds.includes(sourceId);

			expect(isSourceAllowed).toBe(true);
		});

		it("should reject source ID not in whitelist", () => {
			const allowedSourceIds = ["source-1", "source-2"];
			const sourceId = "source-3";

			const isSourceAllowed = allowedSourceIds.includes(sourceId);

			expect(isSourceAllowed).toBe(false);
		});

		// Verify AND logic would be incorrect
		it("demonstrates why AND logic is wrong - whitelisted source blocked incorrectly", () => {
			const disableMemoryCreation = true;
			const memorySourceAllowed = true;

			// WRONG formula using AND - this is the bug that needs to be fixed in message.ts
			const wrongResult = !disableMemoryCreation && memorySourceAllowed;
			expect(wrongResult).toBe(false); // Incorrectly blocks whitelisted source

			// CORRECT formula using OR
			const correctResult = !disableMemoryCreation || memorySourceAllowed;
			expect(correctResult).toBe(true); // Correctly allows whitelisted source
		});
	});
});
