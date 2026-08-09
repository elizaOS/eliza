/**
 * Reproduces the Seeker Notes-navigation failure through the real core planner
 * executor, VIEWS handler, callback settlement, and callback voice gate.
 */

import {
	executePlannedToolCall,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	ModelType,
	runV5MessageRuntimeStage1,
	type State,
	wrapSingleTurnVisibleCallback,
} from "@elizaos/core";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "@elizaos/core/runtime/builtin-field-evaluators.js";
import { ResponseHandlerFieldRegistry } from "@elizaos/core/runtime/response-handler-field-registry.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViewsAction } from "./views.js";
import type { ViewSummary } from "./views-client.js";

const NOTES_VIEW: ViewSummary = {
	id: "notes",
	label: "Notes",
	path: "/notes",
	pluginName: "plugin-notes",
	available: true,
	viewType: "gui",
	capabilities: [
		{
			id: "create-note",
			description:
				"Create a durable note from one user-authored content field.",
			params: {
				content: {
					type: "string",
					description: "Complete note content.",
					required: true,
					minLength: 1,
					pattern: "\\S",
				},
			},
		},
	],
};

function message(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000101",
		entityId: "00000000-0000-0000-0000-000000000102",
		agentId: "00000000-0000-0000-0000-000000000103",
		roomId: "00000000-0000-0000-0000-000000000104",
		content: { text, source: "client_chat" },
		createdAt: 1,
	} as Memory;
}

function state(): State {
	return {
		values: { availableContexts: "general" },
		data: {},
		text: "Recent conversation summary",
	};
}

function responseHandlerFieldRegistry(): ResponseHandlerFieldRegistry {
	const registry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		registry.register(evaluator);
	}
	return registry;
}

function makeRuntime(
	action: ReturnType<typeof createViewsAction>,
	useModel = vi.fn(
		async () =>
			'```json\n{"response":"i couldn\'t create the note because the content was missing."}\n```',
	),
): IAgentRuntime {
	return {
		agentId: "00000000-0000-0000-0000-000000000103",
		character: { name: "Eliza", system: "Be concise." },
		actions: [action],
		providers: [],
		getRoom: vi.fn(async () => null),
		getService: vi.fn(() => null),
		getSetting: vi.fn(() => undefined),
		emitEvent: vi.fn(async () => undefined),
		runActionsByMode: vi.fn(async () => undefined),
		reportError: vi.fn(),
		useModel,
		responseHandlerFieldRegistry: responseHandlerFieldRegistry(),
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

function makeAction() {
	const listViews = vi.fn(async () => [NOTES_VIEW]);
	const action = createViewsAction({
		client: {
			listViews,
			getCurrentView: vi.fn(async () => ({
				viewId: "notes",
				viewLabel: "Notes",
				viewType: "gui" as const,
				viewPath: "/notes",
			})),
		},
		hasOwnerAccess: vi.fn(async () => true),
	});
	return { action, listViews };
}

async function executeViews(
	runtime: IAgentRuntime,
	inbound: Memory,
	params: Record<string, unknown>,
	callback?: HandlerCallback,
) {
	return executePlannedToolCall(
		runtime,
		{
			message: inbound,
			activeContexts: ["general"],
			userRoles: ["USER"],
			callback,
		},
		{ name: "VIEWS", params },
		{ actions: runtime.actions },
	);
}

describe("VIEWS action ownership after planner selection", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_PORT", "3456");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input, init) => {
				const url = String(input);
				if (url.includes("/navigate")) {
					return new Response(null, { status: 200 });
				}
				const body = JSON.parse(String(init?.body)) as {
					capability: string;
					params?: Record<string, unknown>;
				};
				const content = body.params?.content;
				const success =
					body.capability === "create-note" &&
					typeof content === "string" &&
					content.trim().length > 0;
				return Response.json({
					success,
					result: {
						success,
						text: success
							? `Created note “${content}”.`
							: "The note content was missing.",
					},
				});
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it.each([
		"Pretty close. Uh, can you take me to the notes so we can see all of our notes?",
		"Wow. That's pretty early. Um, do you want to take us over to the notes page?",
	])(
		"keeps planner-selected show/notes navigation attached to its own callback: %s",
		async (text) => {
			const { action, listViews } = makeAction();
			const useModel = vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "handle-response",
							name: "HANDLE_RESPONSE",
							arguments: {
								shouldRespond: "RESPOND",
								thought: "Open the Notes view.",
								contexts: ["general"],
								intents: ["open notes view"],
								candidateActionNames: ["VIEWS"],
								replyText: "On it.",
								facts: [],
								relationships: [],
								addressedTo: [],
								requiresTool: true,
							},
						},
					],
				})
				.mockResolvedValueOnce({
					text: "Opening Notes.",
					toolCalls: [
						{
							id: "views-call",
							name: "VIEWS",
							args: {
								action: "show",
								view: "notes",
								eliza_turn_scope: "final",
							},
						},
					],
				})
				.mockResolvedValue(
					'```json\n{"response":"i couldn\'t create the note because the content was missing."}\n```',
				);
			const runtime = makeRuntime(action, useModel);
			const delivered = vi.fn(async () => []);
			const inbound = message(text);
			const deliveredVisibleTexts = new Set<string>();
			const settledResults: unknown[] = [];
			const callback = wrapSingleTurnVisibleCallback(
				runtime,
				inbound,
				delivered,
				(visibleText) =>
					deliveredVisibleTexts.add(visibleText.trim().toLowerCase()),
			);

			const result = await runV5MessageRuntimeStage1({
				runtime,
				message: inbound,
				state: state(),
				responseId: inbound.id,
				callback,
				deliveredVisibleTexts,
				onSettledActionResult: (settled) => settledResults.push(settled),
			});

			expect(result.kind).toBe("planned_reply");
			if (result.kind !== "planned_reply") return;
			expect(result.result.responseContent).toBeNull();
			expect(result.result.responseMessages).toEqual([]);
			expect(result.result.actionResults).toMatchObject([
				{
					success: true,
					text: "Opened Notes.",
					userFacingText: "Opened Notes.",
					verifiedUserFacing: true,
					values: { mode: "show", viewId: "notes" },
				},
			]);
			expect(settledResults).toHaveLength(1);
			expect(delivered).toHaveBeenCalledTimes(1);
			expect(delivered).toHaveBeenCalledWith(
				{ text: "Opened Notes.", agentVoiced: true },
				"VIEWS",
			);
			expect(useModel.mock.calls.map(([modelType]) => modelType)).toEqual([
				ModelType.RESPONSE_HANDLER,
				ModelType.ACTION_PLANNER,
			]);
			expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
				"http://127.0.0.1:3456/api/views/notes/navigate",
				expect.objectContaining({ method: "POST" }),
			);
			expect(
				vi
					.mocked(globalThis.fetch)
					.mock.calls.some(([url]) => String(url).includes("/interact")),
			).toBe(false);
			expect(listViews).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps an unknown explicit show target on the typed navigation failure path", async () => {
		const { action, listViews } = makeAction();
		const runtime = makeRuntime(action);

		const result = await executeViews(
			runtime,
			message("Can you take me over to the retired ledger page?"),
			{ action: "show", view: "retired-ledger" },
		);

		expect(result).toMatchObject({
			success: false,
			text: expect.stringContaining('No view matches "retired-ledger".'),
		});
		expect(listViews).toHaveBeenCalledTimes(1);
		expect(
			vi
				.mocked(globalThis.fetch)
				.mock.calls.some(([url]) => String(url).includes("/interact")),
		).toBe(false);
	});

	it("keeps explicit one-field Notes creation and its missing-content failure honest", async () => {
		const { action } = makeAction();
		const runtime = makeRuntime(action);
		const inbound = message("Create a note saying launch the video tomorrow.");

		const created = await executeViews(runtime, inbound, {
			action: "interact",
			view: "notes",
			capability: "create-note",
			params: { content: "launch the video tomorrow" },
		});
		const missing = await executeViews(runtime, message("Create a note."), {
			action: "interact",
			view: "notes",
			capability: "create-note",
			params: {},
		});

		expect(created).toMatchObject({
			success: true,
			text: "Created note “launch the video tomorrow”.",
			values: {
				mode: "interact",
				viewId: "notes",
				capability: "create-note",
			},
			data: {
				params: { content: "launch the video tomorrow" },
			},
		});
		expect(missing).toMatchObject({
			success: false,
			text: expect.stringContaining(
				'capability "create-note" requires parameter "content"',
			),
		});
		expect(
			vi
				.mocked(globalThis.fetch)
				.mock.calls.filter(([url]) => String(url).includes("/interact")),
		).toHaveLength(1);
		expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				body: JSON.stringify({
					capability: "create-note",
					params: { content: "launch the video tomorrow" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
	});
});
