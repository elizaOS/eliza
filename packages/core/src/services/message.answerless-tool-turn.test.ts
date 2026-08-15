/**
 * Answerless tool turn: a turn that ran real tool work and finished with no
 * planner prose must report the outcome, or say plainly that it produced none.
 * It must never promote the pre-tool Stage-1 ack into the turn's terminal
 * message — the live shape where an addressed turn ran several tool calls and
 * the user received only "On it.".
 *
 * Drives the real `DefaultMessageService.handleMessage` pipeline (real
 * `AgentRuntime`, in-memory adapter, real planner loop, real action execution)
 * with only the model transport scripted, so every assertion is against the
 * bytes the connector callback actually received.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCharacter } from "../character";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import type { Action, Content, HandlerCallback, Memory, UUID } from "../types";
import { ModelType } from "../types";
import { ChannelType } from "../types/primitives";
import {
	DefaultMessageService,
	NO_REPORTABLE_TOOL_OUTCOME_MESSAGE,
} from "./message";

const AGENT_ID = "00000000-0000-0000-0000-000000000091" as UUID;
const USER_ID = "00000000-0000-0000-0000-000000000092" as UUID;

const STAGE_ONE_ACK = "On it.";
const DIAGNOSTIC = "read_file path=bot.log bytes=8412 exit=0";
const TOOL_OUTCOME =
	"Last 3 lines of bot.log: startup ok, 2 warnings, no errors.";

interface ScriptedAction {
	name: string;
	asyncHandoff?: boolean;
	result: Record<string, unknown>;
	deliverThroughCallback?: string;
}

function stageOneAckTurn(candidateActionNames: readonly string[]) {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: "Needs a tool.",
					contexts: ["general"],
					intents: ["read the log"],
					candidateActionNames: [...candidateActionNames],
					replyText: STAGE_ONE_ACK,
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

/** Evaluator envelope: goal met, evaluator owns no prose of its own. */
const EVALUATOR_FINISH = JSON.stringify({
	success: true,
	decision: "FINISH",
	thought: "The tool ran.",
});
/** Evaluator envelope: keep planning from the recorded results. */
const EVALUATOR_CONTINUE = JSON.stringify({
	success: false,
	decision: "CONTINUE",
	thought: "More work is needed.",
});

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
	callback: HandlerCallback;
	callbacks: Content[];
}

const activeRuntimes: AgentRuntime[] = [];

/**
 * Scripts Stage 1 (ack + tool requirement), the planner turns, and the
 * evaluator turns. The last planner turn is always a terminal tool call with
 * no REPLY — the shape that makes the loop finish with no final message.
 */
async function createHarness(options: {
	actions: readonly ScriptedAction[];
	plannerToolNames: readonly string[];
	evaluatorScript: readonly string[];
}): Promise<Harness> {
	const runtime = new AgentRuntime({
		character: createCharacter({
			id: AGENT_ID,
			name: "Answerless Tool Turn",
			bio: "Exercises the answerless-final delivery floor.",
			settings: {},
		}),
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
		enableAutonomy: false,
	});
	await runtime.initialize({ skipMigrations: true });
	activeRuntimes.push(runtime);

	runtime.actions.length = 0;
	runtime.evaluators.length = 0;
	runtime.composeState = vi.fn(async () => ({
		values: { availableContexts: "general" },
		data: {},
		text: "Deterministic answerless-tool-turn state.",
	})) as AgentRuntime["composeState"];

	for (const scripted of options.actions) {
		runtime.registerAction({
			name: scripted.name,
			description: "Reads or writes a stored artifact.",
			...(scripted.asyncHandoff ? { asyncHandoff: true as const } : {}),
			parameters: [
				{
					name: "target",
					description: "What to operate on",
					required: true,
					schema: { type: "string" },
				},
			],
			validate: async () => true,
			handler: async (_rt, _msg, _state, _opts, cb) => {
				if (scripted.deliverThroughCallback && cb) {
					await cb({
						text: scripted.deliverThroughCallback,
						actions: ["REPLY"],
					});
				}
				return scripted.result as never;
			},
		} satisfies Action);
	}

	let stageOneServed = false;
	let evaluatorTurn = 0;
	runtime.registerModel(
		ModelType.RESPONSE_HANDLER,
		async () => {
			if (!stageOneServed) {
				stageOneServed = true;
				return stageOneAckTurn(options.actions.map((action) => action.name));
			}
			const scripted = options.evaluatorScript[evaluatorTurn];
			evaluatorTurn += 1;
			return scripted ?? EVALUATOR_FINISH;
		},
		"answerless-tool-turn-test",
		100,
	);

	let plannerTurn = 0;
	runtime.registerModel(
		ModelType.ACTION_PLANNER,
		async () => {
			const toolName = options.plannerToolNames[plannerTurn];
			plannerTurn += 1;
			if (toolName) {
				return {
					thought: `Run ${toolName}.`,
					toolCalls: [
						{
							id: `call-${plannerTurn}`,
							name: toolName,
							args: { target: "bot.log" },
						},
					],
				};
			}
			// Terminal-only iteration with NO REPLY call: the loop finishes with
			// `finalMessage: undefined` — the answerless shape this file pins.
			return {
				thought: "Nothing more to do.",
				toolCalls: [{ id: "terminal-1", name: "STOP" }],
			};
		},
		"answerless-tool-turn-test",
		100,
	);
	runtime.registerModel(
		ModelType.TEXT_SMALL,
		async () => "",
		"answerless-tool-turn-test",
		100,
	);
	runtime.registerModel(
		ModelType.TEXT_LARGE,
		async () => "",
		"answerless-tool-turn-test",
		100,
	);

	const callbacks: Content[] = [];
	runtime.registerSendHandler("client_chat", async () => undefined);
	const callback: HandlerCallback = async (content: Content) => {
		callbacks.push(content);
		return [];
	};

	return { runtime, callback, callbacks };
}

function visibleTexts(contents: Content[]): string[] {
	return contents
		.map((content) => (typeof content.text === "string" ? content.text : ""))
		.filter((text) => text.trim().length > 0);
}

async function runTurn(harness: Harness, text: string) {
	return new DefaultMessageService().handleMessage(
		harness.runtime,
		makeMessage(harness.runtime, text),
		harness.callback,
	);
}

describe("answerless tool turn", () => {
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

	it("reports the absence of a result instead of shipping the pre-tool ack", async () => {
		const harness = await createHarness({
			actions: [
				{ name: "LOOKUP", result: { success: true, text: DIAGNOSTIC } },
			],
			plannerToolNames: ["LOOKUP"],
			evaluatorScript: [EVALUATOR_CONTINUE],
		});

		const result = await runTurn(
			harness,
			"read me the last few lines of the bot log",
		);

		const delivered = visibleTexts(harness.callbacks);
		expect(delivered).toEqual([NO_REPORTABLE_TOOL_OUTCOME_MESSAGE]);
		expect(result.responseContent?.text).toBe(
			NO_REPORTABLE_TOOL_OUTCOME_MESSAGE,
		);
		// The interim ack must never become the turn's terminal message, and the
		// diagnostic tool text must never render as assistant prose.
		expect(delivered).not.toContain(STAGE_ONE_ACK);
		expect(delivered.join("\n")).not.toContain(DIAGNOSTIC);
	});

	it("delivers an earlier tool's undelivered outcome rather than the ack", async () => {
		const harness = await createHarness({
			actions: [
				{
					name: "LOOKUP",
					result: {
						success: true,
						text: DIAGNOSTIC,
						userFacingText: TOOL_OUTCOME,
					},
				},
				{ name: "WRITE", result: { success: false, text: "write failed" } },
			],
			plannerToolNames: ["LOOKUP", "WRITE"],
			evaluatorScript: [EVALUATOR_CONTINUE, EVALUATOR_CONTINUE],
		});

		const result = await runTurn(
			harness,
			"read me the last few lines of the bot log",
		);

		const delivered = visibleTexts(harness.callbacks);
		expect(delivered).toContain(TOOL_OUTCOME);
		expect(delivered).not.toContain(STAGE_ONE_ACK);
		expect(result.responseContent?.text).toBe(TOOL_OUTCOME);
	});

	it("keeps the ack when an asyncHandoff action carries the work past the turn", async () => {
		const harness = await createHarness({
			actions: [
				{
					name: "LOOKUP",
					asyncHandoff: true,
					result: { success: true, text: DIAGNOSTIC },
				},
			],
			plannerToolNames: ["LOOKUP"],
			evaluatorScript: [EVALUATOR_CONTINUE],
		});

		const result = await runTurn(harness, "build me the thing");

		// The spawned work outlives the turn, so "on it" IS the honest outcome.
		expect(visibleTexts(harness.callbacks)).toEqual([STAGE_ONE_ACK]);
		expect(result.responseContent?.text).toBe(STAGE_ONE_ACK);
	});

	it("does not keep the ack when an asyncHandoff spawn fails to accept", async () => {
		const harness = await createHarness({
			actions: [
				{
					name: "LOOKUP",
					asyncHandoff: true,
					result: {
						success: false,
						text: "spawn rejected: no coding backend available",
						error: "no coding backend available",
					},
				},
			],
			plannerToolNames: ["LOOKUP"],
			evaluatorScript: [EVALUATOR_CONTINUE],
		});

		const result = await runTurn(harness, "build me the thing");

		// A failed spawn shares the action name/flag but no work continues —
		// shipping "On it." would claim a handoff that never started.
		const delivered = visibleTexts(harness.callbacks);
		expect(delivered).toEqual([NO_REPORTABLE_TOOL_OUTCOME_MESSAGE]);
		expect(delivered).not.toContain(STAGE_ONE_ACK);
		expect(result.responseContent?.text).toBe(
			NO_REPORTABLE_TOOL_OUTCOME_MESSAGE,
		);
	});

	it("delivers a failed sync tool's userFacingText instead of the ack or generic no-result line", async () => {
		const failureFacing =
			"Couldn't open bot.log: permission denied on the workspace path.";
		const harness = await createHarness({
			actions: [
				{
					name: "LOOKUP",
					result: {
						success: false,
						text: DIAGNOSTIC,
						userFacingText: failureFacing,
						verifiedUserFacing: true,
					},
				},
			],
			plannerToolNames: ["LOOKUP"],
			evaluatorScript: [EVALUATOR_CONTINUE],
		});

		const result = await runTurn(
			harness,
			"read me the last few lines of the bot log",
		);

		const delivered = visibleTexts(harness.callbacks);
		expect(delivered).toEqual([failureFacing]);
		expect(delivered).not.toContain(STAGE_ONE_ACK);
		expect(delivered).not.toContain(NO_REPORTABLE_TOOL_OUTCOME_MESSAGE);
		expect(result.responseContent?.text).toBe(failureFacing);
	});

	it("adds no trailing ack when an action already delivered the outcome", async () => {
		const harness = await createHarness({
			actions: [
				{
					name: "LOOKUP",
					deliverThroughCallback: TOOL_OUTCOME,
					result: { success: true, text: DIAGNOSTIC },
				},
			],
			plannerToolNames: ["LOOKUP"],
			evaluatorScript: [EVALUATOR_CONTINUE],
		});

		await runTurn(harness, "read me the last few lines of the bot log");

		// One bubble: the action's own outcome. A trailing "On it." would be a
		// redundant, out-of-order second message.
		expect(visibleTexts(harness.callbacks)).toEqual([TOOL_OUTCOME]);
	});
});
