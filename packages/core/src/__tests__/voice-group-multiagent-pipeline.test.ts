/**
 * C9 (#8786): multi-agent VOICE_GROUP turn-taking through the Stage-1 pipeline.
 *
 * The existing `voice-group-room.test.ts` exercises the `core.voice_group_address`
 * evaluator in isolation. This drives the REAL `runV5MessageRuntimeStage1` for
 * EACH of several named agents sharing one VOICE_GROUP room, fed the SAME
 * utterance addressed to ONE of them ("Eliza, what's the time?" →
 * addressedTo:["Eliza"]). It asserts the end-to-end outcome the room contract
 * promises:
 *   - the addressed agent (Eliza) reaches a real reply (not terminal IGNORE),
 *   - every un-addressed agent terminates with action === "IGNORE" — driven by
 *     the builtin voice-group address gate inside the live pipeline, not a
 *     hand-rolled evaluator call.
 *
 * Each agent is its own Stage-1 run over its own runtime (an agent only ever
 * processes a turn as itself). Zero LLM spend: the model is a fixture queue that
 * emits the SAME HANDLE_RESPONSE for every agent — only the agent's identity and
 * the gate decide who replies, exactly as in a real room where all agents see
 * the same transcribed utterance.
 */

import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import type { V5MessageRuntimeStage1Result } from "../services/message";
import { runV5MessageRuntimeStage1 } from "../services/message";
import type { Memory } from "../types/memory";
import { ChannelType, type UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

const ROOM = "11111111-1111-1111-1111-111111111111" as UUID;
const SPEAKER = "22222222-2222-2222-2222-222222222222" as UUID;
const MESSAGE_ID = "33333333-3333-3333-3333-333333333333" as UUID;
const RESPONSE_ID = "00000000-0000-0000-0000-000000000005" as UUID;

const UTTERANCE = "Eliza what's the time";
/** The transcription/extraction resolves the named target of the utterance. */
const ADDRESSED_TO = ["Eliza"];

/** One transcribed voice-group turn, shared by every agent in the room. */
function voiceGroupMessage(): Memory {
	return {
		id: MESSAGE_ID,
		entityId: SPEAKER,
		roomId: ROOM,
		content: {
			text: UTTERANCE,
			source: "voice",
			channelType: ChannelType.VOICE_GROUP,
		},
		createdAt: 1,
	};
}

function makeState(): State {
	return {
		values: { availableContexts: "general" },
		data: {},
		text: "Voice room transcript",
	};
}

/**
 * The Stage-1 model fixture. The same envelope is emitted for EVERY agent:
 * shouldRespond RESPOND + the extracted `addressedTo`. Whether the agent
 * actually replies is decided downstream by `core.voice_group_address`, NOT by
 * the model — which is the whole point of the room gate.
 */
function respondFixture() {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: "I could answer the time.",
					// `simple` keeps the addressed agent on the Stage-1 direct-reply
					// path (no planner model call) — the addressed agent answers from
					// replyText; the gate, not the planner, decides who is suppressed.
					contexts: ["simple"],
					intents: [],
					candidateActionNames: [],
					replyText: "It's 3 o'clock.",
					facts: [],
					relationships: [],
					addressedTo: ADDRESSED_TO,
				},
			},
		],
		finishReason: "tool_calls",
	};
}

function makeAgentRuntime(agentName: string): IAgentRuntime {
	const agentId =
		`00000000-0000-0000-0000-0000000000a${agentName.length}` as UUID;
	const queue: unknown[] = [respondFixture()];

	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}

	return {
		agentId,
		character: { name: agentName, system: "Be brief.", bio: "" },
		actions: [],
		providers: [],
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		useModel: vi.fn(async () => {
			if (queue.length === 0) throw new Error("Unexpected useModel call");
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
	} as unknown as IAgentRuntime;
}

/** Run one agent's Stage-1 turn for the shared voice-group utterance. */
async function runAgentTurn(
	agentName: string,
): Promise<V5MessageRuntimeStage1Result> {
	return runV5MessageRuntimeStage1({
		runtime: makeAgentRuntime(agentName),
		message: voiceGroupMessage(),
		state: makeState(),
		responseId: RESPONSE_ID,
	});
}

function isIgnore(result: V5MessageRuntimeStage1Result): boolean {
	return result.kind === "terminal" && result.action === "IGNORE";
}

describe("multi-agent VOICE_GROUP turn-taking through the Stage-1 pipeline (#8786 C9)", () => {
	it("only the addressed agent replies; the other agents IGNORE (3-agent room)", async () => {
		// A room with three agents — only "Eliza" was addressed.
		const eliza = await runAgentTurn("Eliza");
		const claude = await runAgentTurn("Claude");
		const aria = await runAgentTurn("Aria");

		// The addressed agent is NOT suppressed: it reaches a real reply.
		expect(isIgnore(eliza)).toBe(false);
		expect(
			eliza.kind === "direct_reply" || eliza.kind === "planned_reply",
		).toBe(true);

		// The two un-addressed agents defer via core.voice_group_address.
		expect(isIgnore(claude)).toBe(true);
		expect(isIgnore(aria)).toBe(true);
	});

	it("exactly one agent in the room ends up replying", async () => {
		const roster = ["Eliza", "Claude", "Aria", "Nova"];
		const results = await Promise.all(roster.map((name) => runAgentTurn(name)));
		const repliers = roster.filter((_, i) => !isIgnore(results[i]));
		// The contract: precisely the single addressed agent replies — no
		// cross-talk storm, no silence.
		expect(repliers).toEqual(["Eliza"]);
	});

	it("the SAME utterance as a single-party VOICE_DM is not group-suppressed", async () => {
		// VOICE_DM is single-party: the group address gate must not fire, so even
		// an agent not named in `addressedTo` still answers normally.
		const result = await runV5MessageRuntimeStage1({
			runtime: makeAgentRuntime("Claude"),
			message: {
				...voiceGroupMessage(),
				content: {
					...voiceGroupMessage().content,
					channelType: ChannelType.VOICE_DM,
				},
			},
			state: makeState(),
			responseId: RESPONSE_ID,
		});
		expect(isIgnore(result)).toBe(false);
	});
});
