import { describe, expect, it, vi } from "vitest";
import { runV5MessageRuntimeStage1 } from "../services/message";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

function useModelCalls(runtime: IAgentRuntime): unknown[][] {
	return (runtime.useModel as unknown as { mock: { calls: unknown[][] } }).mock
		.calls;
}

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		roomId: "00000000-0000-0000-0000-000000000004" as UUID,
		content: {
			text: "Can you check my calendar?",
			source: "test",
		},
		createdAt: 1,
	};
}

function makeState(): State {
	return {
		values: {
			availableContexts: "general, calendar",
		},
		data: {},
		text: "Recent conversation summary",
	};
}

function makeRuntime(responses: unknown[]): IAgentRuntime {
	const queue = [...responses];
	return {
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		character: {
			name: "Test Agent",
			system: "You are concise.",
		},
		actions: [],
		providers: [],
		composeState: vi.fn(async () => makeState()),
		useModel: vi.fn(async () => {
			if (queue.length === 0) {
				throw new Error("Unexpected useModel call");
			}
			return queue.shift();
		}),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

describe("runV5MessageRuntimeStage1", () => {
	it("requests the required native message-handler tool and parses tool arguments", async () => {
		const runtime = makeRuntime([
			{
				text: "",
				toolCalls: [
					{
						id: "mh-1",
						name: "MESSAGE_HANDLER_PLAN",
						arguments: {
							plan: {
								contexts: ["simple"],
								reply: "Hello.",
							},
							thought: "Direct answer.",
						},
					},
				],
				finishReason: "tool_calls",
			},
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("direct_reply");
		const firstCall = useModelCalls(runtime)[0];
		const params = firstCall?.[1] as {
			tools?: Array<{ name?: string }>;
			toolChoice?: string;
			responseSchema?: unknown;
			responseFormat?: unknown;
		};
		expect(params.tools?.[0]?.name).toBe("MESSAGE_HANDLER_PLAN");
		expect(params.toolChoice).toBe("required");
		expect(params.responseSchema).toBeUndefined();
		expect(params.responseFormat).toBeUndefined();
		if (result.kind === "direct_reply") {
			expect(result.result.responseContent?.text).toBe("Hello.");
		}
	});

	it("packages Stage 1 as stable system plus dynamic user context without provider internals", async () => {
		const runtime = makeRuntime([
			{
				text: "",
				toolCalls: [
					{
						id: "mh-1",
						toolName: "MESSAGE_HANDLER_PLAN",
						input: {
							plan: {
								contexts: ["simple"],
								reply: "Hello.",
							},
							thought: "Direct answer.",
						},
					},
				],
			},
		]);
		const state: State = {
			values: {
				availableContexts: "simple, general",
			},
			data: {
				providerOrder: ["RECENT_MESSAGES", "PROVIDERS", "CHARACTER"],
				providers: {
					RECENT_MESSAGES: {
						text: "# Conversation Messages\nOperator: hello",
						values: { shouldNotRender: "value leak" },
						data: { secret: "secret leak" },
						providerName: "RECENT_MESSAGES",
					},
					PROVIDERS: {
						text: "# Providers\nproviders[99]: giant catalog",
						providerName: "PROVIDERS",
					},
					CHARACTER: {
						text: "# About Test Agent",
						data: { secrets: { API_KEY: "secret leak" } },
						providerName: "CHARACTER",
					},
				},
			},
			text: "fallback text should not be needed",
		};

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state,
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		const firstCall = useModelCalls(runtime)[0];
		const params = firstCall?.[1] as {
			messages?: Array<{ role?: string; content?: string | null }>;
			prompt?: string;
			promptSegments?: Array<{ content?: string; stable?: boolean }>;
		};
		expect(params.messages?.map((message) => message.role)).toEqual([
			"system",
			"user",
		]);
		const systemContent = params.messages?.[0]?.content ?? "";
		const userContent = params.messages?.[1]?.content ?? "";
		expect(systemContent).toContain("message_handler_stage:");
		expect(systemContent).toContain("available_contexts:");
		expect(userContent).toContain("# Conversation Messages");
		expect(userContent).toContain("Can you check my calendar?");
		const fullPrompt = `${params.prompt ?? ""}\n${systemContent}\n${userContent}`;
		expect(fullPrompt).not.toContain("values:");
		expect(fullPrompt).not.toContain("data:");
		expect(fullPrompt).not.toContain("provider: PROVIDERS");
		expect(fullPrompt).not.toContain("provider: CHARACTER");
		expect(fullPrompt).not.toContain("secret leak");
		expect(params.promptSegments?.some((segment) => segment.stable)).toBe(true);
		expect(params.promptSegments?.some((segment) => !segment.stable)).toBe(
			true,
		);
	});

	it("recomposes planner state with selected context providers but excludes catalogs", async () => {
		const runtime = makeRuntime([
			JSON.stringify({
				action: "RESPOND",
				simple: false,
				contexts: ["knowledge"],
				thought: "Knowledge context is needed.",
			}),
			JSON.stringify({
				thought: "No tool needed in this fixture.",
				toolCalls: [],
				messageToUser: "I found the relevant knowledge.",
			}),
		]);
		runtime.providers = [
			{
				name: "KNOWLEDGE",
				contexts: ["knowledge"],
				get: vi.fn(),
			},
			{
				name: "PROVIDERS",
				contexts: ["knowledge"],
				get: vi.fn(),
			},
			{
				name: "CHARACTER",
				contexts: ["knowledge"],
				get: vi.fn(),
			},
		] as unknown as IAgentRuntime["providers"];

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: {
				values: { availableContexts: "knowledge" },
				data: {},
				text: "",
			},
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		const composeState = runtime.composeState as unknown as {
			mock: { calls: unknown[][] };
		};
		expect(composeState.mock.calls).toHaveLength(1);
		const providerNames = composeState.mock.calls[0]?.[1] as string[];
		expect(providerNames).toContain("KNOWLEDGE");
		expect(providerNames).toContain("RECENT_MESSAGES");
		expect(providerNames).not.toContain("PROVIDERS");
		expect(providerNames).not.toContain("CHARACTER");
	});

	it("returns a simple no-context reply without calling the planner", async () => {
		const runtime = makeRuntime([
			JSON.stringify({
				action: "RESPOND",
				simple: true,
				contexts: [],
				thought: "Direct answer.",
				reply: "Hello.",
			}),
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("direct_reply");
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(useModelCalls(runtime)[0]?.[0]).toBe(ModelType.RESPONSE_HANDLER);
		if (result.kind === "direct_reply") {
			expect(result.result.responseContent?.text).toBe("Hello.");
			expect(result.result.mode).toBe("simple");
		}
	});

	it("runs planning when contexts are selected even when simple is true", async () => {
		const runtime = makeRuntime([
			JSON.stringify({
				action: "RESPOND",
				simple: true,
				contexts: ["calendar"],
				thought: "Calendar context is needed.",
				reply: "I can check.",
			}),
			JSON.stringify({
				thought: "No tool needed in this fixture.",
				toolCalls: [],
				messageToUser: "Your calendar is clear.",
			}),
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
		expect(useModelCalls(runtime)[0]?.[0]).toBe(ModelType.RESPONSE_HANDLER);
		expect(useModelCalls(runtime)[1]?.[0]).toBe(ModelType.ACTION_PLANNER);
		expect(useModelCalls(runtime)[1]?.[2]).toBeUndefined();
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe(
				"Your calendar is clear.",
			);
		}
	});

	it.each([
		"IGNORE",
		"STOP",
	] as const)("stops immediately for %s", async (action) => {
		const runtime = makeRuntime([
			JSON.stringify({
				action,
				simple: false,
				contexts: [],
				thought: "Terminal decision.",
			}),
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result).toMatchObject({
			kind: "terminal",
			action,
		});
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});
});
