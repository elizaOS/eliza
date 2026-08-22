/**
 * Exercises transcript visibility through the real message-service boundary:
 * a real AgentRuntime, in-memory adapter, planner action, persistence, callback,
 * voice gate, and connector send handler with only model responses stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCharacter } from "../character";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import type {
	Action,
	Content,
	HandlerCallback,
	Memory,
	State,
	UUID,
} from "../types";
import { ModelType } from "../types";
import { buildReadSlice, buildReadView } from "../types/content";
import { ChannelType } from "../types/primitives";
import { DefaultMessageService } from "./message";

const AGENT_ID = "00000000-0000-0000-0000-000000000071" as UUID;
const USER_ID = "00000000-0000-0000-0000-000000000072" as UUID;
const INTERNAL_DIAGNOSTIC = [
	"available_views:",
	"  type: gui",
	"  count: 0",
].join("\n");

function stageOneViewsResponse() {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: "Inspect the available views.",
					contexts: ["general"],
					intents: ["inspect available views"],
					candidateActionNames: ["VIEWS"],
					replyText: "",
					facts: [],
					relationships: [],
					addressedTo: [],
					requiresTool: true,
				},
			},
		],
		finishReason: "tool_calls",
	};
}

function plannerViewsCall() {
	return {
		thought: "List the available views.",
		toolCalls: [
			{
				id: "views-list-1",
				name: "VIEWS",
				args: { action: "list" },
			},
		],
	};
}

function plannerFinish(messageToUser: string) {
	return JSON.stringify({
		success: true,
		decision: "FINISH",
		thought: "Return the selected result.",
		messageToUser,
	});
}

function makeMessage(runtime: AgentRuntime, text: string): Memory {
	return {
		entityId: USER_ID,
		agentId: runtime.agentId,
		roomId: runtime.agentId,
		content: {
			text,
			source: "client_chat",
			channelType: ChannelType.DM,
		},
		createdAt: Date.now(),
	};
}

interface Harness {
	runtime: AgentRuntime;
	actionHandler: ReturnType<typeof vi.fn>;
	callback: HandlerCallback;
	callbacks: Content[];
	callbackActionNames: Array<string | undefined>;
	sent: Content[];
	voiceHandler: ReturnType<typeof vi.fn>;
}

const activeRuntimes: AgentRuntime[] = [];

async function createHarness(
	finalText: string,
	actionCallbackText?: string,
	actionPromptData?: Record<string, unknown>,
): Promise<Harness> {
	const runtime = new AgentRuntime({
		character: createCharacter({
			id: AGENT_ID,
			name: "Transcript Visibility Integration",
			bio: "Exercises the real message-service delivery boundary.",
			settings: actionPromptData
				? { ELIZA_PROGRESSIVE_CONTENT_PROJECTION: true }
				: {},
		}),
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
		enableAutonomy: false,
	});
	await runtime.initialize({ skipMigrations: true });
	activeRuntimes.push(runtime);

	// Preserve the real runtime registries and storage while keeping prompt
	// composition deterministic and independent of unrelated provider output.
	runtime.actions.length = 0;
	runtime.evaluators.length = 0;
	runtime.composeState = vi.fn(async () => {
		return {
			values: { availableContexts: "general" },
			data: {},
			text: "Deterministic transcript-visibility state.",
		} as State;
	}) as AgentRuntime["composeState"];

	const actionHandler = vi.fn(
		async (
			_runtime,
			_message,
			_state,
			_options,
			actionCallback?: HandlerCallback,
		) => {
			if (actionCallbackText) {
				await actionCallback?.({
					text: actionCallbackText,
					actions: ["VIEWS"],
				});
			}
			return {
				success: true,
				text: INTERNAL_DIAGNOSTIC,
				transcriptVisibility: "internal" as const,
				data: { views: [] },
				...(actionPromptData ? { promptData: actionPromptData } : {}),
			};
		},
	);
	const viewsAction: Action = {
		name: "VIEWS",
		description: "Lists the available application views.",
		parameters: [
			{
				name: "action",
				description: "View operation",
				required: true,
				schema: { type: "string", enum: ["list"] },
			},
		],
		validate: async () => true,
		handler: actionHandler,
	};
	runtime.registerAction(viewsAction);

	const responseQueue = [stageOneViewsResponse(), plannerFinish(finalText)];
	const responseHandler = vi.fn(async () => {
		const next = responseQueue.shift();
		if (next === undefined) {
			throw new Error("Unexpected RESPONSE_HANDLER model call");
		}
		return next;
	});
	const plannerQueue = [plannerViewsCall()];
	const plannerHandler = vi.fn(async () => {
		const next = plannerQueue.shift();
		if (next === undefined) {
			throw new Error("Unexpected ACTION_PLANNER model call");
		}
		return next;
	});
	const voiceHandler = vi.fn(async () => finalText);
	runtime.registerModel(
		ModelType.RESPONSE_HANDLER,
		responseHandler,
		"transcript-visibility-test",
		100,
	);
	runtime.registerModel(
		ModelType.ACTION_PLANNER,
		plannerHandler,
		"transcript-visibility-test",
		100,
	);
	runtime.registerModel(
		ModelType.TEXT_SMALL,
		voiceHandler,
		"transcript-visibility-test",
		100,
	);

	const callbacks: Content[] = [];
	const callbackActionNames: Array<string | undefined> = [];
	const sent: Content[] = [];
	runtime.registerSendHandler(
		"client_chat",
		async (_runtime, _target, content) => {
			sent.push(content);
			return undefined;
		},
	);

	const callback: HandlerCallback = async (content: Content, actionName) => {
		callbacks.push(content);
		callbackActionNames.push(actionName);
		await runtime.sendMessageToTarget(
			{ source: "client_chat", roomId: runtime.agentId },
			content,
		);
		return [];
	};

	return {
		runtime,
		actionHandler,
		callback,
		callbacks,
		callbackActionNames,
		sent,
		voiceHandler,
	};
}

function canonicalDiagnostic(text: string | undefined): string {
	return (text ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.join("\n")
		.trim();
}

async function assistantMemories(runtime: AgentRuntime): Promise<Memory[]> {
	const stored = await runtime.getMemories({
		roomId: runtime.agentId,
		tableName: "messages",
	});
	return stored.filter((memory) => memory.entityId === runtime.agentId);
}

describe("DefaultMessageService transcript visibility integration", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_LOGGING", "0");
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await Promise.all(
			activeRuntimes.splice(0).map(async (runtime) => {
				await runtime.stop();
				await runtime.close();
			}),
		);
	});

	it("marks an exact internal action diagnostic before persistence and suppresses every delivery boundary", async () => {
		const harness = await createHarness(INTERNAL_DIAGNOSTIC);
		const result = await new DefaultMessageService().handleMessage(
			harness.runtime,
			makeMessage(harness.runtime, "What apps are available?"),
			harness.callback,
		);

		expect(harness.actionHandler).toHaveBeenCalledTimes(1);
		expect(canonicalDiagnostic(result.responseContent?.text)).toBe(
			canonicalDiagnostic(INTERNAL_DIAGNOSTIC),
		);
		expect(result.responseContent?.transcriptVisibility).toBe("internal");
		expect(result.responseMessages).toHaveLength(1);
		expect(result.responseMessages[0]?.content.transcriptVisibility).toBe(
			"internal",
		);

		const persisted = await assistantMemories(harness.runtime);
		expect(persisted).toHaveLength(1);
		expect(canonicalDiagnostic(persisted[0]?.content.text)).toBe(
			canonicalDiagnostic(INTERNAL_DIAGNOSTIC),
		);
		expect(persisted[0]?.content.transcriptVisibility).toBe("internal");
		expect(harness.callbacks).toEqual([]);
		expect(harness.sent).toEqual([]);
		expect(harness.voiceHandler).not.toHaveBeenCalled();
	});

	it("keeps a distinct evaluator summary visible, persisted, and delivered exactly once", async () => {
		const visibleSummary = "There are no app views available right now.";
		const harness = await createHarness(visibleSummary);
		const result = await new DefaultMessageService().handleMessage(
			harness.runtime,
			makeMessage(harness.runtime, "Summarize the available apps."),
			harness.callback,
		);

		expect(harness.actionHandler).toHaveBeenCalledTimes(1);
		expect(result.actionResults).toEqual([
			expect.objectContaining({
				text: INTERNAL_DIAGNOSTIC,
				transcriptVisibility: "internal",
			}),
		]);
		expect(result.responseContent?.text).toBe(visibleSummary);
		expect(result.responseContent?.transcriptVisibility).toBeUndefined();

		// Delivery and persistence run concurrently; only their terminal
		// guarantees are stable across adapters and operating-system schedulers.
		const persisted = await assistantMemories(harness.runtime);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]?.content.text).toBe(visibleSummary);
		expect(persisted[0]?.content.transcriptVisibility).toBeUndefined();
		expect(harness.callbacks).toHaveLength(1);
		expect(harness.callbacks[0]?.text).toBe(visibleSummary);
		expect(harness.callbackActionNames).toEqual([undefined]);
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.text).toBe(visibleSummary);
		expect(harness.voiceHandler).toHaveBeenCalledTimes(1);
	});

	it("preserves action attribution through the real message-service callback", async () => {
		const visibleSummary = "The available views are ready.";
		const harness = await createHarness(visibleSummary, visibleSummary);
		const result = await new DefaultMessageService().handleMessage(
			harness.runtime,
			makeMessage(harness.runtime, "List the available apps."),
			harness.callback,
		);

		expect(result.actionResults).toEqual([
			expect.objectContaining({
				success: true,
				data: expect.objectContaining({ actionName: "VIEWS" }),
			}),
		]);
		expect(harness.callbacks).not.toHaveLength(0);
		expect(harness.callbackActionNames).toContain("VIEWS");
	});

	it("persists the live planner content manifest before delivery and mirrors it onto the assistant reply", async () => {
		const documentView = buildReadView({
			reference: {
				kind: "document",
				ref: "document:44444444-4444-4444-8444-444444444444",
				revision: "rev-1",
			},
			slice: buildReadSlice({
				range: { unit: "byte", start: 0, end: 10, total: 20 },
				completeness: "partial-recoverable",
				revision: "rev-1",
				sliceSha256: "a".repeat(64),
			}),
		});
		const visibleSummary = "The requested document page is available.";
		const harness = await createHarness(visibleSummary, undefined, {
			document: documentView,
		});
		const message = makeMessage(harness.runtime, "Inspect the document.");
		const originalUpdateMemory = harness.runtime.updateMemory.bind(
			harness.runtime,
		);
		const originalGetMemoryById = harness.runtime.getMemoryById.bind(
			harness.runtime,
		);
		let manifestUpdateSettled = false;
		let manifestReadbackSettled = false;
		const updateMemory = vi
			.spyOn(harness.runtime, "updateMemory")
			.mockImplementation(async (memory) => {
				const updated = await originalUpdateMemory(memory);
				if (
					(memory.metadata as Record<string, unknown> | undefined)?.[
						"elizaos:progressiveContent"
					]
				) {
					manifestUpdateSettled = true;
				}
				return updated;
			});
		const getMemoryById = vi
			.spyOn(harness.runtime, "getMemoryById")
			.mockImplementation(async (id) => {
				const stored = await originalGetMemoryById(id);
				if (
					(stored?.metadata as Record<string, unknown> | undefined)?.[
						"elizaos:progressiveContent"
					]
				) {
					manifestReadbackSettled = true;
				}
				return stored;
			});

		let callbackObservedSettledBridge = false;
		const callback: HandlerCallback = async (content, actionName) => {
			expect(manifestUpdateSettled).toBe(true);
			expect(manifestReadbackSettled).toBe(true);
			callbackObservedSettledBridge = true;
			return harness.callback(content, actionName);
		};
		const result = await new DefaultMessageService().handleMessage(
			harness.runtime,
			message,
			callback,
		);

		expect(callbackObservedSettledBridge).toBe(true);
		expect(updateMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				id: message.id,
				metadata: expect.objectContaining({
					"elizaos:progressiveContent": expect.any(Object),
				}),
			}),
		);
		expect(getMemoryById).toHaveBeenCalledWith(message.id);
		const incomingEnvelope = (
			message.metadata as Record<string, unknown> | undefined
		)?.["elizaos:progressiveContent"];
		const assistantEnvelope = (
			result.responseMessages.at(-1)?.metadata as
				| Record<string, unknown>
				| undefined
		)?.["elizaos:progressiveContent"];
		expect(incomingEnvelope).toEqual(expect.any(Object));
		expect(assistantEnvelope).toEqual(incomingEnvelope);
		expect(harness.callbacks).toHaveLength(1);
	});
});
