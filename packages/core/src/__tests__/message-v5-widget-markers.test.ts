/**
 * Exercises callback, verified-payload, and evaluator widget-marker delivery through stage 1 with deterministic fixtures (#14658, #14659).
 */
import { describe, expect, it, vi } from "vitest";
import { parseInteractionBlocks } from "../messaging/interactions/parse";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import { runV5MessageRuntimeStage1 } from "../services/message";
import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
} from "../types/components";
import type { ChoiceInteraction, FormInteraction } from "../types/interactions";
import type { Memory } from "../types/memory";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

const MSG_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const SENDER_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const AGENT_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000004" as UUID;
const RESPONSE_ID = "00000000-0000-0000-0000-000000000005" as UUID;

const CHOICE_BLOCK = [
	"I found an installed app named Notes. What would you like to do?",
	"[CHOICE:app-create id=intent-1]",
	"new=Create a new app",
	"edit-1=Edit existing: Notes",
	"cancel=Cancel",
	"[/CHOICE]",
].join("\n");

const FORM_BLOCK = [
	"Here are the details I need:",
	"[FORM]",
	JSON.stringify({
		id: "reminder-form",
		title: "Reminder details",
		fields: [
			{ name: "report", type: "text", label: "Report name", required: true },
			{ name: "day", type: "date", label: "Deadline day", required: true },
			{ name: "time", type: "time", label: "Reminder time", required: true },
		],
	}),
	"[/FORM]",
].join("\n");

function makeMessage(text: string): Memory {
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
		values: { availableContexts: "general, apps" },
		data: {},
		text: "Recent conversation summary",
	};
}

function stage1Response(fields: {
	contexts: string[];
	thought: string;
	candidateActionNames?: string[];
}) {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: fields.thought,
					contexts: fields.contexts,
					intents: [],
					candidateActionNames: fields.candidateActionNames ?? [],
					replyText: "",
					facts: [],
					relationships: [],
					addressedTo: [],
				},
			},
		],
	};
}

function evaluatorFinish(messageToUser: string) {
	return JSON.stringify({
		success: true,
		decision: "FINISH",
		thought: "Turn complete.",
		messageToUser,
	});
}

function makeRuntime(opts: {
	actions: Action[];
	responses: unknown[];
}): IAgentRuntime {
	const queue = [...opts.responses];
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	return {
		agentId: AGENT_ID,
		character: {
			name: "Test Agent",
			system: "You are concise.",
			bio: "I help with practical tasks.",
		},
		actions: opts.actions,
		providers: [],
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
		emitEvent: vi.fn(async () => undefined),
		runActionsByMode: vi.fn(async () => undefined),
		useModel: vi.fn(async (modelType: unknown) => {
			if (queue.length === 0) {
				throw new Error(
					`Unexpected useModel call (modelType=${String(modelType)}); queue empty`,
				);
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
	} as IAgentRuntime;
}

function makeAction(opts: {
	name: string;
	handler: (
		runtime: IAgentRuntime,
		message: Memory,
		state: State | undefined,
		options: HandlerOptions,
		callback?: HandlerCallback,
	) => Promise<ActionResult>;
}): Action {
	return {
		name: opts.name,
		description: `${opts.name} test action`,
		similes: [],
		examples: [],
		parameters: [],
		validate: async () => true,
		handler: opts.handler,
	} as Action;
}

describe("v5 widget markers — action callback and verified payload channels", () => {
	it("delivers an action's callback-emitted [CHOICE] block to the connector callback verbatim", async () => {
		const connectorDeliveries: Array<{ text: string; actionName?: string }> =
			[];
		const connectorCallback: HandlerCallback = vi.fn(
			async (response, actionName) => {
				connectorDeliveries.push({
					text: String(response.text ?? ""),
					...(actionName !== undefined ? { actionName } : {}),
				});
				return [];
			},
		);
		const picker = makeAction({
			name: "APP_PICKER",
			handler: async (_runtime, _message, _state, _options, callback) => {
				await callback?.({ text: CHOICE_BLOCK });
				return { success: true, text: "choice presented; awaiting pick" };
			},
		});
		const runtime = makeRuntime({
			actions: [picker],
			responses: [
				stage1Response({
					contexts: ["general"],
					thought: "App creation needs the picker action.",
					candidateActionNames: ["APP_PICKER"],
				}),
				{
					text: "",
					toolCalls: [{ id: "call-1", name: "APP_PICKER", args: {} }],
				},
				evaluatorFinish("On it."),
			],
		});

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("Create a notes app for me."),
			state: makeState(),
			responseId: RESPONSE_ID,
			callback: connectorCallback,
		});

		// The deterministic code-authored channel: the handler's widget text
		// reached the connector callback verbatim, attributed to the action.
		expect(connectorCallback).toHaveBeenCalledTimes(1);
		expect(connectorDeliveries).toEqual([
			{ text: CHOICE_BLOCK, actionName: "APP_PICKER" },
		]);

		// The delivered text parses at the render boundary with the shared
		// grammar — exactly what the dashboard/Discord/Telegram renderers do.
		const { blocks, cleanedText } = parseInteractionBlocks(
			connectorDeliveries[0].text,
		);
		expect(blocks).toHaveLength(1);
		const choice = blocks[0] as ChoiceInteraction;
		expect(choice.kind).toBe("choice");
		expect(choice.scope).toBe("app-create");
		expect(choice.id).toBe("intent-1");
		expect(choice.options.map((option) => option.value)).toEqual([
			"new",
			"edit-1",
			"cancel",
		]);
		expect(cleanedText).toBe(
			"I found an installed app named Notes. What would you like to do?",
		);

		// The evaluator's paraphrase stays the turn's final message; connectors
		// dedup identical text per turn, so both channels may deliver safely.
		expect(result.kind).toBe("planned_reply");
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe("On it.");
		}
	});

	it("prefers an action's verified [CHOICE] payload over the evaluator paraphrase", async () => {
		const picker = makeAction({
			name: "APP_PICKER",
			handler: async () => ({
				success: true,
				text: "choice presented; awaiting pick",
				userFacingText: CHOICE_BLOCK,
				verifiedUserFacing: true,
			}),
		});
		const runtime = makeRuntime({
			actions: [picker],
			responses: [
				stage1Response({
					contexts: ["general"],
					thought: "App creation needs the picker action.",
					candidateActionNames: ["APP_PICKER"],
				}),
				{
					text: "",
					toolCalls: [{ id: "call-1", name: "APP_PICKER", args: {} }],
				},
				evaluatorFinish("On it."),
			],
		});

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("Create a notes app for me."),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		expect(result.kind).toBe("planned_reply");
		if (result.kind !== "planned_reply") return;
		// Verified user-facing payloads are priority 1 for the final message:
		// the verbatim marker block wins over "On it.".
		expect(result.result.responseContent?.text).toBe(CHOICE_BLOCK);
		const { blocks } = parseInteractionBlocks(
			String(result.result.responseContent?.text ?? ""),
		);
		expect(blocks).toHaveLength(1);
		expect((blocks[0] as ChoiceInteraction).scope).toBe("app-create");
	});

	it("keeps a model-authored [FORM] messageToUser intact through the evaluator boundary", async () => {
		const lookup = makeAction({
			name: "REMINDER_LOOKUP",
			handler: async () => ({
				success: true,
				text: "no matching reminder found; details required",
			}),
		});
		const runtime = makeRuntime({
			actions: [lookup],
			responses: [
				stage1Response({
					contexts: ["general"],
					thought: "Reminder request needs a lookup, then details.",
					candidateActionNames: ["REMINDER_LOOKUP"],
				}),
				{
					text: "",
					toolCalls: [{ id: "call-1", name: "REMINDER_LOOKUP", args: {} }],
				},
				evaluatorFinish(FORM_BLOCK),
			],
		});

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(
				"I need a reminder — you'll need the report name, the day, and the time from me.",
			),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		expect(result.kind).toBe("planned_reply");
		if (result.kind !== "planned_reply") return;
		// The [FORM] body is a JSON object on its own line — the reply
		// sanitizers must treat it as user-visible interaction payload, not a
		// JSON/tool attempt to strip (#14659).
		expect(result.result.responseContent?.text).toBe(FORM_BLOCK);
		const { blocks, cleanedText } = parseInteractionBlocks(
			String(result.result.responseContent?.text ?? ""),
		);
		expect(blocks).toHaveLength(1);
		const form = blocks[0] as FormInteraction;
		expect(form.kind).toBe("form");
		expect(form.id).toBe("reminder-form");
		expect(form.fields.map((field) => field.name)).toEqual([
			"report",
			"day",
			"time",
		]);
		expect(cleanedText).toBe("Here are the details I need:");
	});
});
