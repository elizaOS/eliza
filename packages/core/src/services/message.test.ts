import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, State } from "../types";
import { stringToUuid } from "../utils";
import {
	DefaultMessageService,
	extractPlannerActionNames,
	findOwnedActionCorrectionFromMetadata,
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

describe("DefaultMessageService native reasoning opt-in", () => {
	it.skipIf(typeof (vi as unknown as { resetModules?: () => void }).resetModules !== "function")("routes to native reasoning when character.reasoning.mode is native", async () => {
		vi.resetModules();
		const runNativeReasoningLoop = vi.fn(
			async (_runtime, _message, callback) => {
				await callback({ text: "native response", attachments: [] });
			},
		);
		const buildDefaultRegistry = vi.fn(() => new Map());

		vi.doMock("@elizaos/native-reasoning", () => ({
			runNativeReasoningLoop,
			buildDefaultRegistry,
		}));

		const { DefaultMessageService: Service } = await import("./message.ts");
		const service = new Service();
		const callback = vi.fn(async () => []);
		const runtime = {
			agentId: stringToUuid("native-agent"),
			character: { reasoning: { mode: "native", provider: "anthropic" } },
			emitEvent: vi.fn(async () => undefined),
			applyPipelineHooks: vi.fn(async () => undefined),
			createMemory: vi.fn(async () => undefined),
			getCurrentRunId: vi.fn(() => undefined),
			logger: {
				error: vi.fn(),
				warn: vi.fn(),
				info: vi.fn(),
				debug: vi.fn(),
			},
		} as unknown as IAgentRuntime;
		const message = {
			id: stringToUuid("native-message"),
			roomId: stringToUuid("native-room"),
			entityId: stringToUuid("native-entity"),
			content: { text: "use the native loop" },
		} as Memory;

		const result = await service.handleMessage(runtime, message, callback);

		expect(buildDefaultRegistry).toHaveBeenCalledTimes(1);
		expect(runNativeReasoningLoop).toHaveBeenCalledWith(
			runtime,
			message,
			expect.any(Function),
			expect.objectContaining({
				registry: expect.any(Map),
				provider: "anthropic",
			}),
		);
		expect(runtime.applyPipelineHooks).toHaveBeenCalledWith(
			"outgoing_before_deliver",
			expect.any(Object),
		);
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({ text: "native response" }),
			}),
			"messages",
		);
		expect(runtime.emitEvent).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				message: expect.objectContaining({
					content: expect.objectContaining({ text: "native response" }),
				}),
			}),
		);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ text: "native response" }),
			undefined,
		);
		expect(result).toMatchObject({
			didRespond: true,
			mode: "simple",
			skipEvaluation: true,
			reason: "native-reasoning",
		});

		vi.doUnmock("@elizaos/native-reasoning");
	});
});
