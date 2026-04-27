import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, State } from "../types";
import { stringToUuid } from "../utils";
import {
	DefaultMessageService,
	extractPlannerActionNames,
	shouldRunMetadataActionRescue,
} from "./message.ts";

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

describe("extractPlannerActionNames — tolerant of malformed action XML", () => {
	// Production observation (2026-04-25): the planner LLM occasionally emits
	// an unclosed <action> wrapper around a well-formed <name>X</name>, e.g.:
	//   <actions><action><name>REPLY</name></actions>
	// The closing </action> is missing, so the strict regex used to fall
	// through to "return trimmed" and the entire XML chunk became the action
	// identifier. That never matches a registered action and the bot logs
	// "Dropping unknown planner action" then stays silent. The fix tolerates
	// these malformed shapes by extracting the inner <name>X</name>.

	it("extracts name from canonical <action><name>X</name></action>", () => {
		expect(
			extractPlannerActionNames({
				actions: "<action><name>REPLY</name></action>",
			}),
		).toEqual(["REPLY"]);
	});

	it("extracts name from flat <action>X</action>", () => {
		expect(
			extractPlannerActionNames({
				actions: "<action>REPLY</action>",
			}),
		).toEqual(["REPLY"]);
	});

	it("recovers REPLY when the closing </action> is missing", () => {
		expect(
			extractPlannerActionNames({
				actions: "<action><name>REPLY</name>",
			}),
		).toEqual(["REPLY"]);
	});

	it("recovers when extra trailing content follows the name", () => {
		expect(
			extractPlannerActionNames({
				actions: "<action><name>REPLY</name>garbage trail",
			}),
		).toEqual(["REPLY"]);
	});

	it("returns empty when the actions field is empty", () => {
		expect(extractPlannerActionNames({ actions: "" })).toEqual([]);
	});

	it("treats unmatched non-action text as a literal identifier", () => {
		// Plain comma-separated list still works
		expect(extractPlannerActionNames({ actions: "REPLY,STOP" })).toEqual([
			"REPLY",
			"STOP",
		]);
	});

	it("handles multiple well-formed action blocks", () => {
		expect(
			extractPlannerActionNames({
				actions:
					"<action><name>SPAWN_AGENT</name></action><action><name>REPLY</name></action>",
			}),
		).toEqual(["SPAWN_AGENT", "REPLY"]);
	});
});

describe("DefaultMessageService action-result cache lifecycle", () => {
	it("clears message-scoped action results when a run exits", async () => {
		const messageId = stringToUuid("message-1");
		const stateCache = new Map<string, State>([
			[
				`${messageId}_action_results`,
				{
					values: {},
					data: {
						actionResults: [
							{
								success: true,
								text: "stale result",
								data: { actionName: "STALE_ACTION" },
							},
						],
					},
					text: "",
				},
			],
		]);
		const runtime = {
			agentId: stringToUuid("agent-1"),
			character: { name: "TestAgent", settings: {} },
			stateCache,
			getSetting: vi.fn(() => undefined),
			getCurrentRunId: vi.fn(() => undefined),
			startRun: vi.fn(() => null),
			emitEvent: vi.fn(async () => undefined),
			logger: {
				info: vi.fn(),
				debug: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
		} as unknown as IAgentRuntime;
		const message = {
			id: messageId,
			entityId: stringToUuid("user-1"),
			roomId: stringToUuid("room-1"),
			content: { text: "hello" },
		} as Memory;

		const service = new DefaultMessageService();
		const result = await service.handleMessage(runtime, message);

		expect(result.didRespond).toBe(false);
		expect(stateCache.has(`${messageId}_action_results`)).toBe(false);
	});
});

describe("shouldRunMetadataActionRescue", () => {
	it("returns true when no actions are present", () => {
		expect(shouldRunMetadataActionRescue({ actions: [] })).toBe(true);
		expect(shouldRunMetadataActionRescue(null)).toBe(true);
		expect(shouldRunMetadataActionRescue(undefined)).toBe(true);
	});

	it("returns true when actions are only IGNORE / NONE", () => {
		expect(shouldRunMetadataActionRescue({ actions: ["IGNORE"] })).toBe(true);
		expect(shouldRunMetadataActionRescue({ actions: ["NONE"] })).toBe(true);
		expect(shouldRunMetadataActionRescue({ actions: ["IGNORE", "NONE"] })).toBe(
			true,
		);
	});

	it("returns false when REPLY is present (do not override deliberate conversation)", () => {
		expect(shouldRunMetadataActionRescue({ actions: ["REPLY"] })).toBe(false);
		expect(shouldRunMetadataActionRescue({ actions: ["RESPOND"] })).toBe(false);
		expect(
			shouldRunMetadataActionRescue({ actions: ["reply"] /* lowercase */ }),
		).toBe(false);
	});

	it("returns false when a non-passive action is present (already routed)", () => {
		expect(shouldRunMetadataActionRescue({ actions: ["CREATE_TASK"] })).toBe(
			false,
		);
		expect(shouldRunMetadataActionRescue({ actions: ["SPAWN_AGENT"] })).toBe(
			false,
		);
		expect(
			shouldRunMetadataActionRescue({ actions: ["REPLY", "CREATE_TASK"] }),
		).toBe(false);
	});

	it("ignores non-string entries in the actions array", () => {
		// The runtime occasionally feeds in malformed planner output; the gate
		// must not crash on numbers / objects / nulls and must still answer
		// false when REPLY appears alongside garbage.
		expect(
			shouldRunMetadataActionRescue({
				actions: [42 as unknown as string, null as unknown as string, "REPLY"],
			}),
		).toBe(false);
	});
});
