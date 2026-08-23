/**
 * Unit tests for the autonomy execution facade's response normalization and
 * post-model routing. The suite drives the real facade with a typed runtime
 * stand-in while isolating the planned-tool executor and evaluator boundaries.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUniqueUuid } from "../../entities";
import { executePlannedToolCall } from "../../runtime/execute-planned-tool-call";
import { runPostTurnEvaluators } from "../../services/evaluator";
import { createMockRuntime } from "../../testing/mock-runtime";
import type {
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../types";
import { stringToUuid } from "../../utils";
import { runAutonomyPostResponse } from "./execution-facade";

vi.mock("../../runtime/execute-planned-tool-call", () => ({
	executePlannedToolCall: vi.fn(),
}));

vi.mock("../../services/evaluator", () => ({
	runPostTurnEvaluators: vi.fn(),
}));

const agentId = stringToUuid("autonomy-agent") as UUID;
const roomId = stringToUuid("autonomy-room") as UUID;
const messageId = stringToUuid("autonomy-message") as UUID;
const state: State = { values: {}, data: {}, text: "composed state" };

const executeTool = vi.mocked(executePlannedToolCall);
const runEvaluators = vi.mocked(runPostTurnEvaluators);

function autonomyMessage(withId = true): Memory {
	return {
		...(withId ? { id: messageId } : {}),
		entityId: stringToUuid("autonomy-entity"),
		agentId,
		roomId,
		content: { text: "Consider the next autonomous step." },
	};
}

function makeRuntime() {
	const createMemory = vi.fn(async () => undefined);
	const composeState = vi.fn(async () => state);
	const applyPipelineHooks = vi.fn(async () => undefined);
	const runActionsByMode = vi.fn(async () => []);
	const debug = vi.fn();
	const runtime = createMockRuntime({
		agentId,
		createMemory,
		composeState,
		applyPipelineHooks,
		runActionsByMode,
		logger: { debug } as IAgentRuntime["logger"],
	});

	return {
		runtime,
		createMemory,
		composeState,
		applyPipelineHooks,
		runActionsByMode,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	runEvaluators.mockResolvedValue(undefined);
	executeTool.mockResolvedValue({ success: true });
});

describe("runAutonomyPostResponse", () => {
	it("normalizes a simple reply, applies delivery hooks, persists it, and invokes the callback", async () => {
		const harness = makeRuntime();
		const message = autonomyMessage();
		const callback = vi.fn(async () => []) as HandlerCallback;

		await runAutonomyPostResponse(
			harness.runtime,
			message,
			{
				actions: [" REPLY ", ""],
				providers: ["profile", 17, "", "recentMessages"],
				thought: "ready",
				text: "Proceeding now.",
			},
			callback,
		);

		expect(harness.composeState).toHaveBeenCalledWith(message, [
			"ACTIONS",
			"RECENT_MESSAGES",
		]);
		expect(harness.applyPipelineHooks).toHaveBeenCalledWith(
			"outgoing_before_deliver",
			expect.objectContaining({
				phase: "outgoing_before_deliver",
				source: "autonomy_simple",
				roomId,
				message,
			}),
		);
		expect(harness.createMemory).toHaveBeenCalledTimes(1);
		const saved = harness.createMemory.mock.calls[0]?.[0];
		expect(saved?.content).toMatchObject({
			actions: ["REPLY"],
			providers: ["profile", "", "recentMessages"],
			thought: "ready",
			text: "Proceeding now.",
			inReplyTo: createUniqueUuid(harness.runtime, messageId),
		});
		expect(callback).toHaveBeenCalledWith(saved?.content);
		expect(executeTool).not.toHaveBeenCalled();
		expect(runEvaluators).toHaveBeenCalledWith(
			harness.runtime,
			message,
			state,
			expect.objectContaining({ didRespond: true, responses: [saved] }),
		);
		expect(harness.runActionsByMode).toHaveBeenCalledWith(
			"ALWAYS_AFTER",
			message,
			state,
			expect.objectContaining({ didRespond: true, responses: [saved] }),
		);
	});

	it("routes a textless REPLY through planned action execution", async () => {
		const harness = makeRuntime();
		const message = autonomyMessage();
		const callback = vi.fn(async () => []) as HandlerCallback;

		await runAutonomyPostResponse(
			harness.runtime,
			message,
			{ actions: "REPLY", text: "" },
			callback,
		);

		expect(harness.applyPipelineHooks).not.toHaveBeenCalled();
		expect(callback).not.toHaveBeenCalled();
		expect(executeTool).toHaveBeenCalledWith(
			harness.runtime,
			expect.objectContaining({
				message,
				state,
				activeContexts: ["general"],
				previousResults: [{ success: true }],
			}),
			{ name: "REPLY" },
		);
	});

	it("treats STOP as a terminal non-response without executing a tool", async () => {
		const harness = makeRuntime();
		const message = autonomyMessage();
		const callback = vi.fn(async () => []) as HandlerCallback;

		await runAutonomyPostResponse(
			harness.runtime,
			message,
			{ actions: " stop ", text: "" },
			callback,
		);

		expect(harness.applyPipelineHooks).toHaveBeenCalledWith(
			"outgoing_before_deliver",
			expect.objectContaining({ source: "excluded", roomId, message }),
		);
		expect(callback).not.toHaveBeenCalled();
		expect(executeTool).not.toHaveBeenCalled();
		expect(runEvaluators).toHaveBeenCalledWith(
			harness.runtime,
			message,
			state,
			expect.objectContaining({ didRespond: false }),
		);
		expect(harness.runActionsByMode).toHaveBeenCalledWith(
			"ALWAYS_AFTER",
			message,
			state,
			expect.objectContaining({ didRespond: false }),
		);
	});

	it("executes comma-separated actions in order with accumulated results and normalized contexts", async () => {
		const harness = makeRuntime();
		const message = autonomyMessage();
		const snapshots: Array<{
			name: string;
			contexts: readonly string[];
			previousResults: readonly ActionResult[];
		}> = [];
		executeTool.mockImplementation(async (_runtime, context, call) => {
			snapshots.push({
				name: call.name,
				contexts: [...(context.activeContexts ?? [])],
				previousResults: [...(context.previousResults ?? [])],
			});
			return { success: true, text: `${call.name} complete` };
		});

		await runAutonomyPostResponse(harness.runtime, message, {
			actions: " FIRST, ,second ",
			contexts: [" Planning ", 7, "GENERAL", "planning"],
			context: "ignored-fallback",
			providers: " profile, , recentMessages ",
			text: "Completed both actions.",
		});

		expect(snapshots).toEqual([
			{
				name: "FIRST",
				contexts: ["general", "planning"],
				previousResults: [],
			},
			{
				name: "second",
				contexts: ["general", "planning"],
				previousResults: [{ success: true, text: "FIRST complete" }],
			},
		]);
		const saved = harness.createMemory.mock.calls[0]?.[0];
		expect(saved?.content).toMatchObject({
			actions: ["FIRST", "second"],
			providers: ["profile", "recentMessages"],
		});
		expect(runEvaluators).toHaveBeenCalledWith(
			harness.runtime,
			message,
			state,
			expect.objectContaining({ didRespond: true }),
		);
	});

	it("falls back through context aliases and forwards action callback results", async () => {
		const harness = makeRuntime();
		const message = autonomyMessage();
		const callbackMemories: Memory[] = [
			{
				entityId: agentId,
				roomId,
				content: { text: "callback memory" },
			},
		];
		const callback = vi.fn(async () => callbackMemories) as HandlerCallback;
		executeTool.mockImplementation(async (_runtime, context) => {
			const returned = await context.callback?.({ text: "action output" });
			expect(returned).toBe(callbackMemories);
			return { success: true };
		});

		await runAutonomyPostResponse(
			harness.runtime,
			message,
			{
				actions: ["WORK"],
				context: " Research; REVIEW\nresearch ",
			},
			callback,
		);

		expect(executeTool).toHaveBeenCalledWith(
			harness.runtime,
			expect.objectContaining({
				activeContexts: ["general", "research", "review"],
			}),
			{ name: "WORK" },
		);
		expect(callback).toHaveBeenCalledWith({ text: "action output" });
	});

	it("defaults malformed fields to IGNORE and omits threading without a source id", async () => {
		const harness = makeRuntime();
		const message = autonomyMessage(false);

		await runAutonomyPostResponse(harness.runtime, message, {
			actions: 42,
			providers: 42,
			primaryContext: " OPS ",
			thought: null,
			text: undefined,
		});

		expect(executeTool).toHaveBeenCalledWith(
			harness.runtime,
			expect.objectContaining({ activeContexts: ["general", "ops"] }),
			{ name: "IGNORE" },
		);
		const saved = harness.createMemory.mock.calls[0]?.[0];
		expect(saved?.content).toEqual({
			actions: ["IGNORE"],
			providers: [],
			thought: "",
			text: "",
		});
		expect(runEvaluators).toHaveBeenCalledWith(
			harness.runtime,
			message,
			state,
			expect.objectContaining({ didRespond: false }),
		);
	});
});
