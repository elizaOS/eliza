/**
 * The evaluator renders its own base context when the loop supplies one
 * (composed without the providers its template never reads); without it the
 * planner base context renders exactly as before. A RESTORE_CONTEXT read by
 * the planner and a contextRequest re-run by the evaluator both refresh that
 * composition, and the pipeline hands it to the loop with the loaded context
 * catalog and the completion-context metadata the planner composition carries.
 */
import { describe, expect, it, vi } from "vitest";
import { HANDLE_RESPONSE_TOOL_NAME } from "../../actions/to-tool";
import { runV5MessageRuntimeStage1 } from "../../services/message";
import { EVALUATOR_STAGE_PROVIDER_EXCLUSIONS } from "../../services/message/provider-state";
import type { ContextObject } from "../../types/context-object";
import type { Memory } from "../../types/memory";
import { ModelType } from "../../types/model";
import { ChannelType, type UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../builtin-field-evaluators";
import { ContextRegistry } from "../context-registry";
import { runEvaluator } from "../evaluator";
import { runPlannerLoop } from "../planner-loop";
import type { PlannerRuntime, PlannerTrajectory } from "../planner-types";
import { ResponseHandlerFieldRegistry } from "../response-handler-field-registry";

// The pipeline test observes the parameters the message service hands the
// loop; every other test runs the real loop through the same pass-through.
vi.mock("../planner-loop", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../planner-loop")>();
	return { ...actual, runPlannerLoop: vi.fn(actual.runPlannerLoop) };
});

function context(id: string, providers: string[]): ContextObject {
	return {
		id,
		staticPrefix: {
			characterPrompt: { content: "agent_name: Eliza", stable: true },
		},
		events: [
			...providers.map((name) => ({
				id: `provider:${name}`,
				type: "provider" as const,
				source: "composeState",
				name,
				text: `${name} block`,
			})),
			{
				id: "history:1",
				type: "segment" as const,
				source: "prior-dialogue",
				segment: {
					id: "history:1",
					label: "prior_message:user",
					content: "nubs: earlier question",
					stable: false,
				},
			},
			{
				id: "msg",
				type: "message" as const,
				message: { role: "user" as const, content: { text: "Check status." } },
			},
		],
	} as ContextObject;
}

const STALE_GUIDE = `STALE_GUIDE_BODY ${"detail ".repeat(300)}`;

/** The same composition with one deferred provider the model may restore. */
function discoverable(base: ContextObject): ContextObject {
	return {
		...base,
		metadata: { ...base.metadata, providerDiscoveryEnabled: true },
		events: [
			{
				id: "provider:GUIDE",
				type: "provider",
				source: "composeState",
				name: "GUIDE",
				text: STALE_GUIDE,
				discoveryText: "Guide syntax available on request.",
			},
			...base.events,
		],
	};
}

function freshGuide(original: ContextObject): ContextObject {
	return {
		...original,
		events: original.events.map((event) =>
			event.id === "provider:GUIDE"
				? { ...event, text: "FRESH_AUTHORIZED_GUIDE" }
				: event,
		),
	};
}

function providerNames(context: ContextObject | undefined): string[] {
	return (context?.events ?? []).flatMap((event) =>
		event.type === "provider" &&
		"name" in event &&
		typeof event.name === "string"
			? [event.name]
			: [],
	);
}

const tools = [
	{
		name: "NOTES",
		description: "Read the exact note",
		parameters: {
			type: "object" as const,
			properties: { id: { type: "string" as const } },
			required: ["id"],
		},
	},
];

function harness() {
	const runtime = {
		useModel: vi.fn(
			async () =>
				'{"success":true,"thought":"Complete.","decision":"FINISH","messageToUser":"Done."}',
		),
	};
	return runtime;
}

function evaluatorUserMessage(runtime: {
	useModel: ReturnType<typeof vi.fn>;
}): string {
	const params = runtime.useModel.mock.calls[0]?.[1] as {
		messages?: Array<{ role: string; content: unknown }>;
	};
	return JSON.stringify(params.messages ?? []);
}

describe("evaluator stage context", () => {
	it("renders the evaluator base context when the loop supplies one", async () => {
		const runtime = harness();
		const full = context("ctx", [
			"RECENT_MESSAGES",
			"ENTITIES",
			"PLATFORM_USER_CONTEXT",
			"FACTS",
		]);
		const forEvaluator = context("ctx", ["RECENT_MESSAGES", "FACTS"]);
		await runEvaluator({
			runtime,
			context: full,
			trajectory: {
				context: full,
				modelBaseContext: full,
				evaluatorBaseContext: forEvaluator,
				steps: [],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});
		const rendered = evaluatorUserMessage(runtime);
		expect(rendered).toContain("RECENT_MESSAGES block");
		expect(rendered).toContain("FACTS block");
		expect(rendered).toContain("earlier question");
		expect(rendered).not.toContain("ENTITIES block");
		expect(rendered).not.toContain("PLATFORM_USER_CONTEXT block");
	});

	it("falls back to the planner base context unchanged when none is supplied", async () => {
		const runtime = harness();
		const full = context("ctx", ["RECENT_MESSAGES", "ENTITIES"]);
		await runEvaluator({
			runtime,
			context: full,
			trajectory: {
				context: full,
				modelBaseContext: full,
				steps: [],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});
		const rendered = evaluatorUserMessage(runtime);
		expect(rendered).toContain("ENTITIES block");
	});

	it("hands the loop's evaluator a trajectory whose evaluatorBaseContext lacks the excluded providers", async () => {
		const full = context("ctx", [
			"RECENT_MESSAGES",
			"ENTITIES",
			"PLATFORM_USER_CONTEXT",
			"FACTS",
		]);
		const forEvaluator = context("ctx", ["RECENT_MESSAGES", "FACTS"]);
		const wires = new Map<string, string>();
		const useModel = vi.fn<PlannerRuntime["useModel"]>(async (type, params) => {
			wires.set(
				String(type),
				JSON.stringify((params as { messages?: unknown }).messages),
			);
			if (type === ModelType.ACTION_PLANNER)
				return {
					text: "",
					toolCalls: [
						{ id: "read", name: "NOTES", arguments: { id: "note-1" } },
					],
				};
			return JSON.stringify({
				success: true,
				decision: "FINISH",
				thought: "Verified.",
				messageToUser: "Done.",
			});
		});
		const result = await runPlannerLoop({
			context: full,
			evaluatorContext: forEvaluator,
			tools,
			runtime: { useModel },
			executeToolCall: async () => ({ success: true, text: "read" }),
		});
		expect(useModel.mock.calls.map(([type]) => type)).toEqual([
			ModelType.ACTION_PLANNER,
			ModelType.RESPONSE_HANDLER,
		]);
		expect(result.trajectory.evaluatorBaseContext).toBe(forEvaluator);
		expect(providerNames(result.trajectory.evaluatorBaseContext)).toEqual([
			"RECENT_MESSAGES",
			"FACTS",
		]);
		expect(providerNames(result.trajectory.modelBaseContext)).toEqual([
			"RECENT_MESSAGES",
			"ENTITIES",
			"PLATFORM_USER_CONTEXT",
			"FACTS",
		]);
		const planner = wires.get(String(ModelType.ACTION_PLANNER)) ?? "";
		const evaluator = wires.get(String(ModelType.RESPONSE_HANDLER)) ?? "";
		expect(planner).toContain("ENTITIES block");
		expect(planner).toContain("PLATFORM_USER_CONTEXT block");
		expect(evaluator).toContain("RECENT_MESSAGES block");
		expect(evaluator).toContain("FACTS block");
		expect(evaluator).toContain("earlier question");
		expect(evaluator).not.toContain("ENTITIES block");
		expect(evaluator).not.toContain("PLATFORM_USER_CONTEXT block");
	});
});

describe("evaluator stage context restoration", () => {
	it("refreshes evaluatorBaseContext when the planner reads RESTORE_CONTEXT", async () => {
		const full = discoverable(
			context("ctx", ["RECENT_MESSAGES", "ENTITIES", "FACTS"]),
		);
		const forEvaluator = discoverable(
			context("ctx", ["RECENT_MESSAGES", "FACTS"]),
		);
		const restore = vi.fn(async (original: ContextObject) =>
			freshGuide(original),
		);
		let planned = 0;
		const result = await runPlannerLoop({
			context: full,
			evaluatorContext: forEvaluator,
			tools,
			runtime: {
				restoreProviderContext: restore,
				useModel: async () => ({
					text: "",
					toolCalls:
						++planned === 1
							? [
									{
										id: "restore",
										name: "RESTORE_CONTEXT",
										arguments: { reason: "Need syntax", scope: "providers" },
									},
								]
							: [{ id: "read", name: "NOTES", arguments: { id: "note-1" } }],
				}),
			},
			executeToolCall: async () => ({ success: true, text: "read" }),
			evaluate: async ({ trajectory }) => {
				// The evaluator reads the refreshed composition on this same round.
				expect(JSON.stringify(trajectory.evaluatorBaseContext)).toContain(
					"FRESH_AUTHORIZED_GUIDE",
				);
				return {
					success: true,
					decision: "FINISH",
					thought: "done",
					messageToUser: "Read.",
				};
			},
		});
		expect(restore).toHaveBeenCalledTimes(1);
		expect(providerNames(restore.mock.calls[0]?.[0])).toContain("ENTITIES");
		const refreshed = result.trajectory.evaluatorBaseContext;
		expect(providerNames(refreshed)).toEqual([
			"GUIDE",
			"RECENT_MESSAGES",
			"FACTS",
		]);
		expect(JSON.stringify(refreshed)).toContain("FRESH_AUTHORIZED_GUIDE");
		expect(JSON.stringify(refreshed)).not.toContain("STALE_GUIDE_BODY");
		expect(JSON.stringify(refreshed)).toContain("earlier question");
		expect(refreshed?.metadata?.providerDiscoveryEnabled).toBe(false);
		// The planner base context restored exactly as before, roster included.
		const plannerBase = result.trajectory.modelBaseContext;
		expect(JSON.stringify(plannerBase)).toContain("FRESH_AUTHORIZED_GUIDE");
		expect(providerNames(plannerBase)).toContain("ENTITIES");
		expect(plannerBase?.metadata?.providerDiscoveryEnabled).toBe(false);
	});

	it("refreshes evaluatorBaseContext when the evaluator re-runs after a contextRequest read", async () => {
		const full = discoverable(
			context("ctx", ["RECENT_MESSAGES", "ENTITIES", "FACTS"]),
		);
		const forEvaluator = discoverable(
			context("ctx", ["RECENT_MESSAGES", "FACTS"]),
		);
		const restore = vi.fn(async (original: ContextObject) =>
			freshGuide(original),
		);
		const trajectory: PlannerTrajectory = {
			context: full,
			modelBaseContext: full,
			evaluatorBaseContext: forEvaluator,
			steps: [],
			archivedSteps: [],
			plannedQueue: [],
			evaluatorOutputs: [],
		};
		const wires: string[] = [];
		const output = await runEvaluator({
			context: full,
			trajectory,
			runtime: {
				restoreProviderContext: restore,
				useModel: async (_type, params) => {
					wires.push(JSON.stringify(params.messages));
					return wires.length === 1
						? JSON.stringify({
								success: false,
								decision: "CONTINUE",
								thought: "Need syntax",
								contextRequest: "providers",
							})
						: JSON.stringify({
								success: true,
								decision: "FINISH",
								thought: "verified",
								messageToUser: "Done.",
							});
				},
			},
		});
		expect(output.decision).toBe("FINISH");
		expect(wires).toHaveLength(2);
		expect(wires[0]).toContain("Guide syntax available on request.");
		expect(wires[0]).not.toContain("STALE_GUIDE_BODY");
		expect(wires[0]).not.toContain("ENTITIES block");
		expect(wires[1]).toContain("FRESH_AUTHORIZED_GUIDE");
		expect(wires[1]).toContain("earlier question");
		expect(wires[1]).not.toContain("ENTITIES block");
		expect(restore).toHaveBeenCalledTimes(1);
		expect(providerNames(restore.mock.calls[0]?.[0])).toContain("ENTITIES");
		expect(providerNames(trajectory.evaluatorBaseContext)).toEqual([
			"GUIDE",
			"RECENT_MESSAGES",
			"FACTS",
		]);
		expect(
			trajectory.evaluatorBaseContext?.metadata?.providerDiscoveryEnabled,
		).toBe(false);
		expect(JSON.stringify(trajectory.modelBaseContext)).toContain(
			"FRESH_AUTHORIZED_GUIDE",
		);
		expect(providerNames(trajectory.modelBaseContext)).toContain("ENTITIES");
		expect(
			trajectory.modelBaseContext?.metadata?.providerDiscoveryEnabled,
		).toBe(false);
	});
});

describe("evaluator stage provider exclusions", () => {
	it("leaves out the blocks that describe what a reply may do, not whether a tool result satisfied the request", () => {
		expect(EVALUATOR_STAGE_PROVIDER_EXCLUSIONS).toEqual(
			expect.arrayContaining([
				"ENTITIES",
				"PLATFORM_USER_CONTEXT",
				"uiWidgets",
				"recent-conversations",
				"relevant-conversations",
				"CHANNEL_TOPICS",
				"firstRun",
			]),
		);
		// The dialogue, facts and the live time stay in.
		for (const kept of ["RECENT_MESSAGES", "FACTS", "CURRENT_TIME"]) {
			expect(EVALUATOR_STAGE_PROVIDER_EXCLUSIONS).not.toContain(kept);
		}
	});
});

function stage1Response(fields: {
	contexts?: string[];
	intents?: string[];
	candidateActionNames?: string[];
	contextRequests?: string[];
	replyText?: string;
	extra?: Record<string, unknown>;
}) {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: HANDLE_RESPONSE_TOOL_NAME,
				arguments: {
					shouldRespond: "RESPOND",
					thought: "",
					contexts: fields.contexts ?? [],
					intents: fields.intents ?? [],
					candidateActionNames: fields.candidateActionNames ?? [],
					contextRequests: fields.contextRequests ?? [],
					replyText: fields.replyText ?? "",
					facts: [],
					relationships: [],
					addressedTo: [],
					...(fields.extra ?? {}),
				},
			},
		],
	};
}

describe("pipeline evaluator context", () => {
	it("hands runPlannerLoop an evaluator context with the loaded catalog and completion metadata but without the excluded providers", async () => {
		const message: Memory = {
			id: "00000000-0000-0000-0000-000000000001" as UUID,
			entityId: "00000000-0000-0000-0000-000000000002" as UUID,
			agentId: "00000000-0000-0000-0000-000000000003" as UUID,
			roomId: "00000000-0000-0000-0000-000000000004" as UUID,
			content: {
				text: "Read the context catalog, then open Home.",
				source: "test",
				channelType: ChannelType.DM,
			},
			createdAt: 20,
		};
		const rows: Memory[] = [
			"Keep Home as my start view.",
			"The notes list is getting long.",
		].map((text, index) => ({
			id: `00000000-0000-0000-0000-00000000001${index}` as UUID,
			entityId: message.entityId,
			agentId: message.agentId,
			roomId: message.roomId,
			content: { text, source: "test" },
			createdAt: index + 1,
		}));
		const state: State = {
			values: { availableContexts: "general, notes" },
			data: {
				providers: {
					ENTITIES: { text: "People in the Room: nubs (owner)." },
					uiWidgets: { text: "Widget syntax catalog: [[button]]." },
					FACTS: { text: "Known fact: the owner opens Home first." },
					RECENT_MESSAGES: { data: { recentMessages: rows } },
				},
			},
			text: "Recent conversation summary",
		};
		const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
		for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS)
			responseHandlerFieldRegistry.register(evaluator);
		const navigate = vi.fn(async () => ({
			success: true,
			text: "Navigation completed: home.",
			data: { destination: "home" },
		}));
		const wires: string[] = [];
		let sourceSetId: string | undefined;
		const runtime = {
			agentId: message.agentId,
			character: {
				name: "Test Agent",
				system: "You are concise.",
				bio: "I help with views.",
			},
			actions: [
				{
					name: "UI_ROUTE",
					description: "Navigate to a requested destination.",
					parameters: [
						{
							name: "destination",
							description: "Destination",
							required: true,
							schema: { type: "string" },
						},
					],
					validate: async () => true,
					handler: navigate,
				},
			],
			providers: [
				{ name: "ENTITIES", get: vi.fn() },
				{ name: "uiWidgets", get: vi.fn() },
				{ name: "FACTS", get: vi.fn() },
				{ name: "RECENT_MESSAGES", get: vi.fn() },
			],
			contexts: new ContextRegistry([
				{ id: "general", description: "General tasks." },
				{
					id: "notes",
					description:
						"Complete routing reference with exact punctuation. ".repeat(40),
				},
			]),
			getService: vi.fn(() => null),
			getRoom: vi.fn(async () => null),
			getModelRegistrations: vi.fn(() => []),
			getSetting: vi.fn(() => undefined),
			composeState: vi.fn(async () => structuredClone(state)),
			runActionsByMode: vi.fn(async () => undefined),
			emitEvent: vi.fn(async () => undefined),
			reportError: vi.fn(),
			useModel: vi.fn(async (_type: unknown, params: unknown) => {
				const messages = (params as { messages?: unknown[] }).messages ?? [];
				const wire = JSON.stringify(messages);
				wires.push(wire);
				switch (wires.length) {
					case 1:
						return stage1Response({
							contexts: ["simple"],
							contextRequests: ["CONTEXT_CATALOG"],
						});
					case 2: {
						const text = messages
							.map((entry) => JSON.stringify(entry))
							.join("\n");
						sourceSetId = text.match(
							/completion_source_set: ([a-f0-9]{64})/,
						)?.[1];
						if (!sourceSetId)
							throw new Error("Stage 1 rendered no completion_source_set");
						return stage1Response({
							contexts: ["general"],
							intents: ["open Home"],
							candidateActionNames: ["UI_ROUTE"],
							replyText: "I will open Home.",
							extra: {
								replyEffectStatus: "pending",
								completionContext: {
									mode: "relevant_prior_dialogue",
									sourceSetId,
									complete: true,
									relevantSourceIds: ["h1"],
									constraintSourceIds: [],
									referentSourceIds: [],
									pendingIntentSourceIds: [],
								},
							},
						});
					}
					case 3:
						return {
							text: "",
							toolCalls: [
								{
									name: "UI_ROUTE",
									arguments: { destination: "home", eliza_turn_scope: "final" },
								},
							],
						};
					default:
						return JSON.stringify({
							success: true,
							decision: "FINISH",
							thought: "The reference and navigation receipt are available.",
							messageToUser: "Home is open.",
						});
				}
			}),
			logger: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				trace: vi.fn(),
			},
			responseHandlerFieldRegistry,
			responseHandlerFieldEvaluators: [
				...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
			],
			responseHandlerEvaluators: [],
		} as unknown as IAgentRuntime;
		vi.mocked(runPlannerLoop).mockClear();
		const result = await runV5MessageRuntimeStage1({
			runtime,
			message,
			state,
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});
		expect(result.kind).toBe("planned_reply");
		expect(navigate).toHaveBeenCalledTimes(1);
		expect(wires).toHaveLength(4);

		const loop = vi.mocked(runPlannerLoop).mock.calls.at(-1)?.[0];
		const plannerContext = loop?.context;
		const evaluatorContext = loop?.evaluatorContext;
		expect(plannerContext).toBeDefined();
		expect(evaluatorContext).toBeDefined();
		expect(evaluatorContext).not.toBe(plannerContext);
		// The catalog the planner loaded, the planner decision and the
		// completion selection reach the evaluator composition unchanged.
		for (const composed of [plannerContext, evaluatorContext]) {
			expect(
				composed?.events.some((event) => event.id === "context-catalog:loaded"),
			).toBe(true);
			expect(
				composed?.events.some((event) => event.type === "message_handler"),
			).toBe(true);
		}
		expect(evaluatorContext?.metadata?.completionContext).toEqual({
			mode: "selected",
			sourceSetId,
			complete: true,
			relevantSourceIds: ["h1"],
			constraintSourceIds: [],
			referentSourceIds: [],
			pendingIntentSourceIds: [],
		});
		for (const key of [
			"completionContext",
			"providerDiscoveryEnabled",
			"historyReferenceEncoding",
			"loadedContextProviders",
		]) {
			expect(evaluatorContext?.metadata?.[key]).toEqual(
				plannerContext?.metadata?.[key],
			);
		}
		// Only the named providers are left out; the planner composition keeps them.
		expect(providerNames(plannerContext)).toEqual(
			expect.arrayContaining([
				"ENTITIES",
				"uiWidgets",
				"FACTS",
				"CONTEXT_CATALOG",
			]),
		);
		expect(providerNames(evaluatorContext)).toEqual(
			expect.arrayContaining(["FACTS", "CONTEXT_CATALOG"]),
		);
		expect(providerNames(evaluatorContext)).not.toContain("ENTITIES");
		expect(providerNames(evaluatorContext)).not.toContain("uiWidgets");
		// On the wire: the planner call still carries the roster and the widget
		// catalog; the in-loop evaluator call carries the loaded catalog and the
		// facts without them.
		expect(wires[2]).toContain("People in the Room");
		expect(wires[2]).toContain("Widget syntax catalog");
		expect(wires[3]).toContain("context_loaded: CONTEXT_CATALOG");
		expect(wires[3]).toContain("Known fact: the owner opens Home first.");
		expect(wires[3]).toContain("Keep Home as my start view.");
		expect(wires[3]).not.toContain("People in the Room");
		expect(wires[3]).not.toContain("Widget syntax catalog");
	});
});
