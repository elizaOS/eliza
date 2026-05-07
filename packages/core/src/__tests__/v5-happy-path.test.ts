import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runV5MessageRuntimeStage1 } from "../services/message";
import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
} from "../types/components";
import type { ContextRegistry } from "../types/contexts";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

const MSG_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const SENDER_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const AGENT_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000004" as UUID;
const RESPONSE_ID = "00000000-0000-0000-0000-000000000005" as UUID;

function makeMessage(
	text = "search for eliza and tell me what you found",
): Memory {
	return {
		id: MSG_ID,
		entityId: SENDER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text, source: "test" },
		createdAt: 1,
	};
}

function makeState(): State {
	return {
		values: { availableContexts: "general, web, memory" },
		data: {},
		text: "Recent conversation summary",
	};
}

interface CannedResponse {
	expectModelType?: string;
	body: unknown;
}

function makeRuntime(opts: {
	actions: Action[];
	responses: CannedResponse[];
	contextRegistry?: ContextRegistry;
}): IAgentRuntime {
	const queue = [...opts.responses];
	const calls: Array<{
		modelType: unknown;
		params: unknown;
		provider: unknown;
	}> = [];
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Test Agent", system: "You are concise." },
		actions: opts.actions,
		providers: [],
		contexts: opts.contextRegistry,
		useModel: vi.fn(
			async (modelType: unknown, params: unknown, provider: unknown) => {
				calls.push({ modelType, params, provider });
				if (queue.length === 0) {
					throw new Error(
						`Unexpected useModel call (modelType=${String(modelType)}); queue empty`,
					);
				}
				const next = queue.shift();
				if (
					next?.expectModelType &&
					String(modelType) !== next.expectModelType
				) {
					throw new Error(
						`Expected ${next.expectModelType} but received ${String(modelType)}`,
					);
				}
				return next?.body;
			},
		),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	} as unknown as IAgentRuntime & { __calls: typeof calls };
	(runtime as unknown as { __calls: typeof calls }).__calls = calls;
	return runtime;
}

function getCalls(runtime: IAgentRuntime): Array<{
	modelType: unknown;
	params: unknown;
	provider: unknown;
}> {
	return (
		runtime as unknown as {
			__calls: Array<{
				modelType: unknown;
				params: unknown;
				provider: unknown;
			}>;
		}
	).__calls;
}

function makeMockAction(opts: {
	name: string;
	handler: (
		runtime: IAgentRuntime,
		message: Memory,
		state: State | undefined,
		options: HandlerOptions,
		callback?: HandlerCallback,
	) => Promise<ActionResult>;
	subActions?: string[];
	contexts?: Action["contexts"];
	parameters?: Array<{
		name: string;
		description: string;
		required?: boolean;
		schema: { type: "string" | "number" | "boolean" | "object" | "array" };
	}>;
}): Action {
	return {
		name: opts.name,
		description: `${opts.name} mock action`,
		similes: [],
		examples: [],
		parameters: opts.parameters ?? [],
		validate: async () => true,
		handler: opts.handler,
		...(opts.subActions ? { subActions: opts.subActions } : {}),
		...(opts.contexts ? { contexts: opts.contexts } : {}),
	} as unknown as Action;
}

let tempDir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "v5-happy-path-"));
	originalEnv = { ...process.env };
	process.env.MILADY_TRAJECTORY_DIR = tempDir;
	process.env.MILADY_TRAJECTORY_RECORDING = "1";
});

afterEach(() => {
	process.env = originalEnv;
	try {
		rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

function readRecordedTrajectories(agentId: string): unknown[] {
	const dir = join(tempDir, agentId);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => JSON.parse(readFileSync(join(dir, entry), "utf8")));
}

describe("v5 happy path — message handler → planner → executor → evaluator", () => {
	it("runs the full pipeline and records every stage to disk", async () => {
		let webSearchCalls = 0;
		const webSearch = makeMockAction({
			name: "WEB_SEARCH",
			parameters: [
				{
					name: "q",
					description: "Search query",
					required: true,
					schema: { type: "string" },
				},
			],
			handler: async (_runtime, _message, _state, options) => {
				webSearchCalls++;
				const params = (options.parameters ?? {}) as Record<string, unknown>;
				expect(params.q).toBe("eliza");
				return {
					success: true,
					text: "found 3 results for 'eliza'",
					data: {
						actionName: "WEB_SEARCH",
						results: [
							{ title: "elizaOS", url: "https://github.com/elizaOS" },
							{
								title: "Eliza chatbot",
								url: "https://en.wikipedia.org/wiki/ELIZA",
							},
							{ title: "Eliza framework", url: "https://eliza.os/docs" },
						],
					},
				};
			},
		});

		const runtime = makeRuntime({
			actions: [webSearch],
			responses: [
				// Stage 1: messageHandler — RESPOND with contexts → planning path
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: JSON.stringify({
						action: "RESPOND",
						simple: false,
						contexts: ["web"],
						thought: "User wants a web search; web context applies.",
					}),
				},
				// Stage 2: planner — emits a single native tool call
				{
					expectModelType: ModelType.ACTION_PLANNER,
					body: {
						text: "Searching the web for 'eliza' now.",
						toolCalls: [
							{ id: "call-1", name: "WEB_SEARCH", args: { q: "eliza" } },
						],
						usage: {
							promptTokens: 4830,
							completionTokens: 142,
							cacheReadInputTokens: 1142,
							cacheCreationInputTokens: 0,
							totalTokens: 4972,
						},
					},
				},
				// Stage 4: evaluator — FINISH with user-facing summary
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "Search succeeded with 3 results.",
						messageToUser: "I found 3 results for 'eliza' on the web.",
					}),
				},
			],
		});

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		// Real handler ran
		expect(webSearchCalls).toBe(1);

		// Final reply was surfaced
		expect(result.kind).toBe("planned_reply");
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toContain("eliza");
		}

		// Three model calls fired: messageHandler + planner + evaluator
		const calls = getCalls(runtime);
		expect(calls.map((c) => c.modelType)).toEqual([
			ModelType.RESPONSE_HANDLER, // messageHandler
			ModelType.ACTION_PLANNER, // planner iteration 1
			ModelType.RESPONSE_HANDLER, // evaluator iteration 1
		]);
		const plannerParams = calls[1]?.params as
			| {
					messages?: unknown[];
					promptSegments?: unknown[];
					responseSchema?: unknown;
					providerOptions?: {
						eliza?: { segmentHashes?: unknown[] };
						cerebras?: { prompt_cache_key?: string; promptCacheKey?: string };
					};
			  }
			| undefined;
		const evaluatorParams = calls[2]?.params as
			| {
					messages?: unknown[];
					promptSegments?: unknown[];
					responseSchema?: unknown;
					providerOptions?: {
						eliza?: { segmentHashes?: unknown[] };
						cerebras?: { prompt_cache_key?: string; promptCacheKey?: string };
					};
			  }
			| undefined;
		expect(plannerParams?.messages?.length).toBeGreaterThan(1);
		expect(evaluatorParams?.messages?.length).toBeGreaterThan(1);
		expect(plannerParams?.promptSegments?.length).toBeGreaterThan(1);
		expect(evaluatorParams?.promptSegments?.length).toBeGreaterThan(1);
		// When tools are present, responseSchema must NOT be sent — providers
		// like Cerebras reject requests that contain both `tools` and
		// `response_format` simultaneously. Native tool calls ARE the
		// structured output when tools are active.
		expect(plannerParams?.responseSchema).toBeUndefined();
		expect(evaluatorParams?.responseSchema).toBeDefined();
		expect(
			plannerParams?.providerOptions?.eliza?.segmentHashes?.length,
		).toBeGreaterThan(0);
		expect(
			evaluatorParams?.providerOptions?.eliza?.segmentHashes?.length,
		).toBeGreaterThan(0);
		expect(plannerParams?.providerOptions?.cerebras?.prompt_cache_key).toMatch(
			/^v5:/,
		);
		expect(evaluatorParams?.providerOptions?.cerebras?.prompt_cache_key).toBe(
			plannerParams?.providerOptions?.cerebras?.prompt_cache_key,
		);

		// Trajectory recording wrote a JSON file
		const recorded = readRecordedTrajectories(String(AGENT_ID));
		expect(recorded.length).toBe(1);
		const trajectory = recorded[0] as {
			trajectoryId: string;
			status: string;
			stages: Array<{
				kind: string;
				tool?: { success: boolean };
				evaluation?: { success: boolean; decision: string };
				model?: { usage?: Record<string, unknown> };
			}>;
			metrics: {
				totalCacheReadTokens: number;
				toolCallsExecuted: number;
				toolCallFailures: number;
				evaluatorFailures: number;
				finalDecision: string;
				plannerIterations: number;
			};
		};

		expect(trajectory.status).toBe("finished");
		expect(trajectory.metrics.toolCallsExecuted).toBe(1);
		expect(trajectory.metrics.toolCallFailures).toBe(0);
		expect(trajectory.metrics.evaluatorFailures).toBe(0);
		expect(trajectory.metrics.finalDecision).toBe("FINISH");
		expect(trajectory.metrics.plannerIterations).toBeGreaterThanOrEqual(1);

		// Cache tokens captured (G4)
		expect(trajectory.metrics.totalCacheReadTokens).toBe(1142);

		// Stage kinds present
		const stageKinds = trajectory.stages.map((s) => s.kind);
		expect(stageKinds).toContain("messageHandler");
		expect(stageKinds).toContain("planner");
		expect(stageKinds).toContain("tool");
		expect(stageKinds).toContain("evaluation");

		// Tool stage records the success
		const toolStage = trajectory.stages.find((s) => s.kind === "tool");
		expect(toolStage?.tool?.success).toBe(true);

		// Evaluation stage records success + decision
		const evalStage = trajectory.stages.find((s) => s.kind === "evaluation");
		expect(evalStage?.evaluation?.success).toBe(true);
		expect(evalStage?.evaluation?.decision).toBe("FINISH");
	});

	it("records evaluator success: false when a tool fails and evaluator says so", async () => {
		const brokenAction = makeMockAction({
			name: "BROKEN_ACTION",
			handler: async () => ({
				success: false,
				text: "broken on purpose",
				error: "intentional failure",
				data: { actionName: "BROKEN_ACTION" },
			}),
		});

		const runtime = makeRuntime({
			actions: [brokenAction],
			responses: [
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: JSON.stringify({
						action: "RESPOND",
						simple: false,
						contexts: ["general"],
						thought: "Try the action.",
					}),
				},
				{
					expectModelType: ModelType.ACTION_PLANNER,
					body: {
						text: "Trying the broken action.",
						toolCalls: [{ id: "call-1", name: "BROKEN_ACTION", args: {} }],
						usage: {
							promptTokens: 100,
							completionTokens: 20,
							totalTokens: 120,
						},
					},
				},
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: JSON.stringify({
						success: false,
						decision: "FINISH",
						thought: "Action failed; cannot proceed.",
						messageToUser: "I hit an error and can't complete that.",
					}),
				},
			],
		});

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("do the broken thing"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		const trajectory = readRecordedTrajectories(String(AGENT_ID))[0] as {
			metrics: {
				evaluatorFailures: number;
				toolCallFailures: number;
				finalDecision: string;
			};
			stages: Array<{
				kind: string;
				tool?: { success: boolean };
				evaluation?: { success: boolean };
			}>;
		};

		expect(trajectory.metrics.toolCallFailures).toBe(1);
		expect(trajectory.metrics.evaluatorFailures).toBe(1);
		expect(trajectory.metrics.finalDecision).toBe("FINISH");

		const evalStage = trajectory.stages.find((s) => s.kind === "evaluation");
		expect(evalStage?.evaluation?.success).toBe(false);
	});

	it("chains a second tool when evaluator returns CONTINUE", async () => {
		let searchCount = 0;
		let saveCount = 0;
		const search = makeMockAction({
			name: "WEB_SEARCH",
			handler: async () => {
				searchCount++;
				return {
					success: true,
					text: "ok",
					data: { actionName: "WEB_SEARCH", results: ["a", "b"] },
				};
			},
		});
		const save = makeMockAction({
			name: "CLIPBOARD_WRITE",
			parameters: [
				{
					name: "content",
					description: "Content to save",
					required: false,
					schema: { type: "string" },
				},
			],
			handler: async () => {
				saveCount++;
				return {
					success: true,
					text: "saved",
					data: { actionName: "CLIPBOARD_WRITE" },
				};
			},
		});

		const runtime = makeRuntime({
			actions: [search, save],
			responses: [
				{
					body: JSON.stringify({
						action: "RESPOND",
						simple: false,
						contexts: ["web", "memory"],
						thought: "Search then save.",
					}),
				},
				// Planner iter 1
				{
					body: {
						text: "Searching first.",
						toolCalls: [{ id: "t1", name: "WEB_SEARCH", args: {} }],
					},
				},
				// Evaluator iter 1: CONTINUE → planner re-runs
				{
					body: JSON.stringify({
						success: true,
						decision: "CONTINUE",
						thought: "Got results, continue with save.",
					}),
				},
				// Planner iter 2
				{
					body: {
						text: "Now saving.",
						toolCalls: [
							{ id: "t2", name: "CLIPBOARD_WRITE", args: { content: "x" } },
						],
					},
				},
				// Evaluator iter 2: FINISH
				{
					body: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "Done.",
						messageToUser: "Saved.",
					}),
				},
			],
		});

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("search and save the result"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		expect(searchCount).toBe(1);
		expect(saveCount).toBe(1);
		expect(result.kind).toBe("planned_reply");

		const trajectory = readRecordedTrajectories(String(AGENT_ID))[0] as {
			metrics: { toolCallsExecuted: number; plannerIterations: number };
		};
		expect(trajectory.metrics.toolCallsExecuted).toBe(2);
		expect(trajectory.metrics.plannerIterations).toBeGreaterThanOrEqual(2);
	});

	it("terminates immediately when planner emits only REPLY (terminal-only path)", async () => {
		const runtime = makeRuntime({
			actions: [],
			responses: [
				// Stage 1: contexts trigger planning
				{
					body: JSON.stringify({
						action: "RESPOND",
						simple: false,
						contexts: ["general"],
						thought: "Context selected.",
					}),
				},
				// Planner emits only a REPLY → terminal-only, no evaluator
				{
					body: {
						text: "Hi there.",
						toolCalls: [
							{ id: "t1", name: "REPLY", args: { text: "Hi there." } },
						],
					},
				},
			],
		});

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("hello"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		// Only 2 model calls fired: messageHandler + planner (no evaluator)
		const calls = getCalls(runtime);
		expect(calls.length).toBe(2);
		expect(calls.map((c) => c.modelType)).toEqual([
			ModelType.RESPONSE_HANDLER,
			ModelType.ACTION_PLANNER,
		]);

		const trajectory = readRecordedTrajectories(String(AGENT_ID))[0] as {
			stages: Array<{ kind: string }>;
		};
		const stageKinds = trajectory.stages.map((s) => s.kind);
		// No evaluation stage in a terminal-only iteration
		expect(stageKinds).not.toContain("evaluation");
	});

	it("invokes a sub-planner when an action declares subActions", async () => {
		let parentDispatched = false;
		let childCount = 0;

		const childA = makeMockAction({
			name: "CALENDAR_LIST_EVENTS",
			parameters: [
				{
					name: "range",
					description: "Date range",
					required: false,
					schema: { type: "string" },
				},
			],
			handler: async () => {
				childCount++;
				return {
					success: true,
					text: "3 events",
					data: { actionName: "CALENDAR_LIST_EVENTS", count: 3 },
				};
			},
		});

		const parent = makeMockAction({
			name: "CALENDAR",
			parameters: [
				{
					name: "intent",
					description: "What the user wants in the calendar domain",
					required: true,
					schema: { type: "string" },
				},
			],
			subActions: ["CALENDAR_LIST_EVENTS"],
			handler: async () => {
				parentDispatched = true;
				return { success: true, text: "parent ran", data: {} };
			},
		});

		const runtime = makeRuntime({
			actions: [parent, childA],
			responses: [
				// Stage 1
				{
					body: JSON.stringify({
						action: "RESPOND",
						simple: false,
						contexts: ["calendar"],
						thought: "Calendar context.",
					}),
				},
				// Outer planner emits CALENDAR (which has subActions → spawns sub-planner)
				{
					body: {
						text: "Entering calendar.",
						toolCalls: [
							{
								id: "t1",
								name: "CALENDAR",
								args: { intent: "list my events" },
							},
						],
					},
				},
				// Inner planner (sub-planner) emits CALENDAR_LIST_EVENTS
				{
					body: {
						text: "Listing events.",
						toolCalls: [
							{
								id: "t2",
								name: "CALENDAR_LIST_EVENTS",
								args: { range: "next-7-days" },
							},
						],
					},
				},
				// Inner evaluator: FINISH (sub-planner done)
				{
					body: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "Got events.",
					}),
				},
				// Outer evaluator: FINISH
				{
					body: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "Done.",
						messageToUser: "Found 3 events.",
					}),
				},
			],
		});

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("list my events"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		// The sub-planner runs CALENDAR_LIST_EVENTS, not the parent's handler
		// (when an action declares subActions, parent.handler is bypassed in favor
		// of the scoped sub-planner per runtime/sub-planner.ts).
		expect(childCount).toBe(1);
		expect(parentDispatched).toBe(false);

		const trajectory = readRecordedTrajectories(String(AGENT_ID))[0] as {
			stages: Array<{
				kind: string;
				tool?: { name: string };
				parentStageId?: string;
			}>;
		};

		// We should see CALENDAR_LIST_EVENTS as a tool stage executed during the inner planner loop.
		const childToolStage = trajectory.stages.find(
			(s) => s.kind === "tool" && s.tool?.name === "CALENDAR_LIST_EVENTS",
		);
		expect(childToolStage).toBeDefined();
	});

	it("Stage 1 prompt does not expose OWNER-only contexts to a USER-role caller", async () => {
		// Build a minimal context registry that exposes one OWNER-only context
		// and one GUEST-accessible context. Stage 1 must show only the GUEST one
		// when the sender resolves to USER role.
		const definitions = [
			{
				id: "general",
				label: "General",
				description: "General conversation",
				gate: { minRole: "GUEST" as const },
				cacheScope: "ephemeral" as const,
				sensitivity: "low" as const,
			},
			{
				id: "secrets",
				label: "Secrets",
				description: "Owner-only credential operations",
				gate: { minRole: "OWNER" as const },
				cacheScope: "trajectory" as const,
				sensitivity: "high" as const,
			},
		];

		const fakeRegistry = {
			listAvailable: (role: string) => {
				if (role === "OWNER") {
					return definitions;
				}
				return definitions.filter((d) => d.gate.minRole !== "OWNER");
			},
		} as unknown as ContextRegistry;

		const runtime = makeRuntime({
			actions: [],
			contextRegistry: fakeRegistry,
			responses: [
				// Stage 1: just stop after seeing the prompt — we only care about the
				// rendered prompt content, not the routing.
				{
					body: JSON.stringify({
						action: "IGNORE",
						simple: false,
						contexts: [],
						thought: "Just inspecting the prompt.",
					}),
				},
			],
		});

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("anything"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		const calls = getCalls(runtime);
		const stage1Params = calls[0]?.params as { prompt?: string } | undefined;
		const renderedPrompt = stage1Params?.prompt ?? "";

		// USER-role caller should see "general" but not "secrets".
		expect(renderedPrompt).toContain("general");
		expect(renderedPrompt).not.toContain("- secrets");
	});

	it("NEXT_RECOMMENDED skips replanning and runs the queued next action", async () => {
		let firstCount = 0;
		let secondCount = 0;

		const first = makeMockAction({
			name: "WEB_SEARCH",
			parameters: [
				{
					name: "q",
					description: "Search query",
					required: false,
					schema: { type: "string" },
				},
			],
			handler: async () => {
				firstCount++;
				return {
					success: true,
					text: "first done",
					data: { actionName: "WEB_SEARCH" },
				};
			},
		});
		const second = makeMockAction({
			name: "CLIPBOARD_WRITE",
			parameters: [
				{
					name: "content",
					description: "Content",
					required: false,
					schema: { type: "string" },
				},
			],
			handler: async () => {
				secondCount++;
				return {
					success: true,
					text: "saved",
					data: { actionName: "CLIPBOARD_WRITE" },
				};
			},
		});

		const runtime = makeRuntime({
			actions: [first, second],
			responses: [
				// Stage 1
				{
					body: JSON.stringify({
						action: "RESPOND",
						simple: false,
						contexts: ["web"],
						thought: "Two-step task.",
					}),
				},
				// Single planner call enqueues BOTH tools
				{
					body: {
						text: "Search then save.",
						toolCalls: [
							{ id: "t1", name: "WEB_SEARCH", args: {} },
							{ id: "t2", name: "CLIPBOARD_WRITE", args: { content: "x" } },
						],
					},
				},
				// Evaluator after first action → NEXT_RECOMMENDED (use already-queued t2)
				{
					body: JSON.stringify({
						success: true,
						decision: "NEXT_RECOMMENDED",
						thought: "Plan still valid; run the queued next.",
						recommendedToolCallId: "t2",
					}),
				},
				// Evaluator after second action → FINISH
				{
					body: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "Done.",
						messageToUser: "Both done.",
					}),
				},
			],
		});

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("search and save"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		expect(firstCount).toBe(1);
		expect(secondCount).toBe(1);

		// Critical: only ONE planner call (the second tool came from NEXT_RECOMMENDED,
		// not a replan). Total calls: messageHandler + planner + evaluator + evaluator = 4.
		const calls = getCalls(runtime);
		const plannerCalls = calls.filter(
			(c) => c.modelType === ModelType.ACTION_PLANNER,
		);
		expect(plannerCalls.length).toBe(1);

		const trajectory = readRecordedTrajectories(String(AGENT_ID))[0] as {
			metrics: { toolCallsExecuted: number; plannerIterations: number };
		};
		expect(trajectory.metrics.toolCallsExecuted).toBe(2);
		// Single planner iteration covered both tools via the queue
		expect(trajectory.metrics.plannerIterations).toBe(1);
	});

	it("filters role-gated contexts and carries tool evidence through CONTINUE replanning", async () => {
		let lookupCount = 0;
		let summarizeCount = 0;
		let adminCount = 0;

		const definitions = [
			{
				id: "general",
				label: "General",
				description: "General user-safe context",
				gate: { minRole: "GUEST" as const },
			},
			{
				id: "admin",
				label: "Admin",
				description: "Owner-only administrative context",
				gate: { minRole: "OWNER" as const },
			},
		];
		const fakeRegistry = {
			listAvailable: (role: string) =>
				role === "OWNER"
					? definitions
					: definitions.filter((definition) => definition.id !== "admin"),
		} as unknown as ContextRegistry;

		const lookup = makeMockAction({
			name: "PUBLIC_LOOKUP",
			contexts: ["general"],
			parameters: [
				{
					name: "query",
					description: "Lookup query",
					required: true,
					schema: { type: "string" },
				},
			],
			handler: async (_runtime, _message, _state, options) => {
				lookupCount++;
				expect(options.parameters?.query).toBe("alpha");
				return {
					success: true,
					text: "lookup evidence: alpha-status=green",
					data: {
						actionName: "PUBLIC_LOOKUP",
						evidenceId: "alpha-status",
						status: "green",
					},
				};
			},
		});
		const summarize = makeMockAction({
			name: "SUMMARIZE_LOOKUP",
			contexts: ["general"],
			handler: async (_runtime, _message, _state, options) => {
				summarizeCount++;
				const prior = options.actionContext?.getPreviousResult("PUBLIC_LOOKUP");
				expect(prior?.data?.evidenceId).toBe("alpha-status");
				return {
					success: true,
					text: "summary used alpha-status evidence",
					data: {
						actionName: "SUMMARIZE_LOOKUP",
						usedEvidenceId: prior?.data?.evidenceId,
					},
				};
			},
		});
		const admin = makeMockAction({
			name: "ADMIN_ESCALATE",
			contexts: ["admin"],
			handler: async () => {
				adminCount++;
				return { success: true, text: "admin", data: {} };
			},
		});

		const runtime = makeRuntime({
			actions: [lookup, summarize, admin],
			contextRegistry: fakeRegistry,
			responses: [
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: JSON.stringify({
						action: "RESPOND",
						simple: false,
						contexts: ["general", "admin"],
						thought: "The user needs a lookup; admin should be filtered.",
					}),
				},
				{
					expectModelType: ModelType.ACTION_PLANNER,
					body: {
						text: "Looking up public status.",
						toolCalls: [
							{
								id: "lookup-1",
								name: "PUBLIC_LOOKUP",
								args: { query: "alpha" },
							},
						],
					},
				},
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: JSON.stringify({
						success: true,
						decision: "CONTINUE",
						thought: "The lookup evidence is present; summarize it next.",
					}),
				},
				{
					expectModelType: ModelType.ACTION_PLANNER,
					body: {
						text: "Summarizing accumulated evidence.",
						toolCalls: [
							{
								id: "summarize-1",
								name: "SUMMARIZE_LOOKUP",
								args: {},
							},
						],
					},
				},
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "Summary used the lookup result.",
						messageToUser: "Alpha status is green.",
					}),
				},
			],
		});

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("check alpha status and summarize it"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(lookupCount).toBe(1);
		expect(summarizeCount).toBe(1);
		expect(adminCount).toBe(0);
		if (result.kind === "planned_reply") {
			expect(result.messageHandler.contexts).toEqual(["general"]);
			expect(result.result.responseContent?.text).toBe(
				"Alpha status is green.",
			);
		}

		const calls = getCalls(runtime);
		const stage1Prompt = String(
			(calls[0]?.params as { prompt?: string } | undefined)?.prompt ?? "",
		);
		expect(stage1Prompt).toContain("- general");
		expect(stage1Prompt).not.toContain("- admin");

		const plannerCalls = calls.filter(
			(call) => call.modelType === ModelType.ACTION_PLANNER,
		);
		expect(plannerCalls.length).toBe(2);
		const firstPlannerParams = plannerCalls[0]?.params as
			| { tools?: Array<{ name?: string }>; prompt?: string }
			| undefined;
		expect(firstPlannerParams?.tools?.map((tool) => tool.name)).toEqual([
			"PUBLIC_LOOKUP",
			"SUMMARIZE_LOOKUP",
		]);
		expect(firstPlannerParams?.prompt).toContain("message_handler");
		expect(firstPlannerParams?.prompt).toContain("selected_contexts: general");
		expect(firstPlannerParams?.prompt).not.toContain("ADMIN_ESCALATE");

		const secondPlannerPrompt = String(
			(plannerCalls[1]?.params as { prompt?: string } | undefined)?.prompt ??
				"",
		);
		expect(secondPlannerPrompt).toContain("PUBLIC_LOOKUP");
		expect(secondPlannerPrompt).toContain("alpha-status");

		const evaluatorCalls = calls.filter(
			(call, index) =>
				index > 0 && call.modelType === ModelType.RESPONSE_HANDLER,
		);
		expect(evaluatorCalls.length).toBe(2);
		const firstEvaluatorPrompt = String(
			(evaluatorCalls[0]?.params as { prompt?: string } | undefined)?.prompt ??
				"",
		);
		expect(firstEvaluatorPrompt).toContain("tool_result");
		expect(firstEvaluatorPrompt).toContain("alpha-status");
		expect(firstEvaluatorPrompt).toContain('"status": "completed"');

		const finalEvaluatorPrompt = String(
			(evaluatorCalls[1]?.params as { prompt?: string } | undefined)?.prompt ??
				"",
		);
		expect(finalEvaluatorPrompt).toContain("SUMMARIZE_LOOKUP");
		expect(finalEvaluatorPrompt).toContain("usedEvidenceId");

		const trajectory = readRecordedTrajectories(String(AGENT_ID))[0] as {
			stages: Array<{
				kind: string;
				model?: { prompt?: string };
				cache?: { segmentHashes: string[]; prefixHash: string };
			}>;
			metrics: { plannerIterations: number; toolCallsExecuted: number };
		};
		expect(trajectory.metrics.plannerIterations).toBe(2);
		expect(trajectory.metrics.toolCallsExecuted).toBe(2);
		const recordedPlanner = trajectory.stages.find(
			(stage) => stage.kind === "planner",
		);
		expect(recordedPlanner?.model?.prompt).toContain("message_handler");
		expect(recordedPlanner?.model?.prompt).toContain("PUBLIC_LOOKUP");
		expect(recordedPlanner?.model?.prompt).not.toContain("ADMIN_ESCALATE");
		expect(recordedPlanner?.cache?.segmentHashes.length).toBeGreaterThan(0);
		expect(recordedPlanner?.cache?.prefixHash).toMatch(/^[a-f0-9]{64}$/);
	});
});
