/**
 * Exercises the planner dispatch-budget fallback of the v5 message runtime
 * (runV5MessageRuntimeStage1) when the complete tool surface exceeds the
 * conservative estimate, Stage 1 names only candidates that resolve to no
 * runtime action, and the umbrella-parent surface still misses the estimate.
 * Deterministic harness: a fabricated runtime whose useModel returns queued
 * responses and whose ACTION_PLANNER registration advertises a one-token
 * window; no live model, no database.
 */
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import { runV5MessageRuntimeStage1 } from "../services/message";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

const AGENT_ID = "00000000-0000-0000-0000-000000000003" as UUID;

function useModelCalls(runtime: IAgentRuntime): unknown[][] {
	return (runtime.useModel as { mock: { calls: unknown[][] } }).mock.calls;
}

function warnCalls(runtime: IAgentRuntime): unknown[][] {
	return (runtime.logger.warn as { mock: { calls: unknown[][] } }).mock.calls;
}

function makeRuntime(responses: unknown[]): IAgentRuntime {
	const queue = [...responses];
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	return {
		agentId: AGENT_ID,
		character: {
			name: "Test Agent",
			system: "You are concise.",
			bio: "I help with calendars.",
		},
		actions: [],
		providers: [],
		getService: vi.fn(() => null),
		getRoom: vi.fn(async () => null),
		// A one-token planner window makes every request miss the utf8
		// upper-bound estimate, which is the live shape once tool schemas alone
		// exceed the window: the estimator cannot clear any surface and the
		// fallback chain must still pick the smallest complete one.
		getModelRegistrations: vi.fn(() => [
			{
				modelType: ModelType.ACTION_PLANNER,
				metadata: { contextWindowTokens: 1 },
			},
		]),
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		reportError: vi.fn(),
		useModel: vi.fn(async () => {
			if (queue.length === 0) {
				throw new Error("Unexpected useModel call");
			}
			return queue.shift();
		}),
		getSetting: vi.fn(() => undefined),
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
	} as IAgentRuntime;
}

function makeMessage(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		agentId: AGENT_ID,
		roomId: "00000000-0000-0000-0000-000000000004" as UUID,
		content: {
			text,
			source: "test",
			mentionContext: { isMention: true },
		},
		createdAt: 1,
	};
}

function makeState(): State {
	return {
		values: { availableContexts: "general, calendar, notes" },
		data: {},
		text: "Recent conversation summary",
	};
}

function stage1Response(candidateActionNames: string[]) {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: "The owner wants a calendar event removed.",
					contexts: ["calendar"],
					intents: ["delete calendar event"],
					candidateActionNames,
					replyText: "",
					facts: [],
					relationships: [],
					addressedTo: [],
				},
			},
		],
	};
}

function parameter(name: string, description: string) {
	return {
		name,
		description,
		required: false,
		schema: { type: "string" },
	};
}

describe("planner dispatch-budget umbrella fallback", () => {
	it("dispatches the umbrella parents when unknown candidates and the estimate leave no fitting surface", async () => {
		const runtime = makeRuntime([
			// Live shape: Stage 1 invents child names that no plugin registers.
			stage1Response(["CALENDAR_DELETE_EVENT", "CALENDAR_FIND_EVENT"]),
			{
				thought: "Remove the event through the calendar dispatcher.",
				toolCalls: [
					{
						id: "calendar-1",
						name: "CALENDAR",
						args: { action: "delete", title: "Gym session" },
					},
				],
			},
		]);
		const calendarHandler = vi.fn(async () => ({
			success: true,
			text: "Gym session removed.",
			continueChain: false,
			data: { actionName: "CALENDAR" },
		}));
		const untouchedHandler = vi.fn(async () => ({
			success: true,
			text: "unexpected",
		}));
		runtime.actions = [
			{
				name: "CALENDAR",
				description: "Calendar operations: read, create, update, delete.",
				parameters: [
					parameter("action", "Calendar operation"),
					parameter("title", "Event title"),
				],
				subActions: ["CALENDAR_DELETE"],
				examples: [],
				validate: async () => true,
				handler: calendarHandler,
			},
			{
				name: "CALENDAR_DELETE",
				description: "Delete one calendar event by title and time.",
				parameters: [parameter("title", "Event title")],
				examples: [],
				validate: async () => true,
				handler: untouchedHandler,
			},
			{
				name: "NOTES",
				description: "Notes operations: create, read, update.",
				parameters: [parameter("action", "Notes operation")],
				subActions: ["NOTES_CREATE"],
				examples: [],
				validate: async () => true,
				handler: untouchedHandler,
			},
			{
				name: "NOTES_CREATE",
				description: "Create a note with a title and body.",
				parameters: [parameter("title", "Note title")],
				examples: [],
				validate: async () => true,
				handler: untouchedHandler,
			},
		] as never;

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(
				"delete the Gym session on tuesday at 7am from my calendar",
			),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(calendarHandler).toHaveBeenCalledTimes(1);
		expect(untouchedHandler).not.toHaveBeenCalled();
		expect(useModelCalls(runtime).map((call) => call[0])).toEqual([
			ModelType.RESPONSE_HANDLER,
			ModelType.ACTION_PLANNER,
		]);

		const plannerParams = useModelCalls(runtime)[1]?.[1] as {
			tools?: { name: string }[];
		};
		const plannerToolNames = plannerParams.tools?.map(({ name }) => name) ?? [];
		expect(plannerToolNames).toEqual(
			expect.arrayContaining(["CALENDAR", "NOTES"]),
		);
		expect(plannerToolNames).not.toContain("CALENDAR_DELETE");
		expect(plannerToolNames).not.toContain("NOTES_CREATE");

		const warnings = warnCalls(runtime);
		const warningDetail = (
			message: string,
		): Record<string, number | string> => {
			const call = warnings.find(([, text]) => text === message);
			if (!call) {
				throw new Error(`expected warning was not logged: ${message}`);
			}
			return call[0] as Record<string, number | string>;
		};
		const initialOverflow = warningDetail(
			"[SERVICE:MESSAGE] Initial planner input exceeds the conservative dispatch budget",
		);
		const retainedDetail = warningDetail(
			"[SERVICE:MESSAGE] Planner retained complete umbrella capability above the conservative estimate as the smallest complete surface",
		);
		const initialToolCount = initialOverflow.toolCount as number;
		expect(retainedDetail.decision).toBe("smaller-than-complete-surface");
		expect(retainedDetail.parentToolCount as number).toBeLessThan(
			initialToolCount,
		);
		expect(retainedDetail.estimatedInputTokens as number).toBeGreaterThan(
			retainedDetail.dispatchThresholdTokens as number,
		);
		expect(
			warnings.some(
				([, message]) =>
					message ===
					"[SERVICE:MESSAGE] Complete umbrella capability still exceeds the planner dispatch budget",
			),
		).toBe(false);
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe("Gym session removed.");
		}
	});
});
