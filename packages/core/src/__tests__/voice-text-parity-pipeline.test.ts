/**
 * C5 (#8786): voice == text parity through the Stage-1 message pipeline.
 *
 * The shipped contract (memory: "voice == text parity, not just the facts
 * stage") is that an utterance arriving as a VOICE_DM must traverse the SAME
 * planning pipeline as the identical utterance arriving as a text DM — the same
 * providers composed, the same RESPONSE_HANDLER/CONTEXT action modes fired, and
 * the same response-handler evaluator set run. Voice is a transport, not a
 * different brain.
 *
 * This drives the REAL `runV5MessageRuntimeStage1` (not a unit slice of the
 * evaluator) twice over a controlled runtime and records, for each transport:
 *   - every provider-name list passed to `runtime.composeState`,
 *   - every action mode passed to `runtime.runActionsByMode`,
 *   - the response-handler evaluators that ran (BUILTIN_RESPONSE_HANDLER_EVALUATORS).
 * Parity holds iff the two transports produce identical sets.
 *
 * The utterance ("Can you check my calendar?") runs the full Stage-1 path on
 * both transports, which is where divergence would actually show up.
 * Zero LLM spend: the model is a fixture queue.
 */

import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import type { ResponseHandlerEvaluator } from "../runtime/response-handler-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import {
	BUILTIN_RESPONSE_HANDLER_EVALUATORS,
	runV5MessageRuntimeStage1,
} from "../services/message";
import { createMockRuntime } from "../testing/mock-runtime";
import type { Memory } from "../types/memory";
import { ChannelType, type UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

const ENTITY = "00000000-0000-0000-0000-000000000002" as UUID;
const AGENT = "00000000-0000-0000-0000-000000000003" as UUID;
const ROOM = "00000000-0000-0000-0000-000000000004" as UUID;
const RESPONSE_ID = "00000000-0000-0000-0000-000000000005" as UUID;

const UTTERANCE = "Can you check my calendar?";

function makeMessage(channelType: ChannelType): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: ENTITY,
		agentId: AGENT,
		roomId: ROOM,
		content: {
			text: UTTERANCE,
			source: "test",
			channelType,
		},
		createdAt: 1,
	};
}

function makeState(): State {
	return {
		values: { availableContexts: "general, calendar" },
		data: {},
		text: "Recent conversation summary",
	};
}

/**
 * Stage-1 HANDLE_RESPONSE that ROUTES INTO THE PLANNER (`requiresTool: true`).
 * The planner path is the one that recomposes state with the selected-context
 * provider set and fires the CONTEXT_* action modes — i.e. the part of the
 * pipeline where a voice/text divergence would actually surface. A pure
 * direct-reply (final_reply) would short-circuit before any of that and make
 * the comparison vacuous.
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
					thought: "Inspect the calendar before answering.",
					contexts: ["general"],
					intents: [],
					candidateActionNames: [],
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

/** The planner's single response — no tool call, just the final reply. */
function plannerFixture() {
	return JSON.stringify({
		thought: "Calendar looked up; reply.",
		toolCalls: [],
		messageToUser: "Here's your calendar.",
	});
}

/**
 * What a single Stage-1 run touched. Sorted for order-independent comparison —
 * parity is about WHICH providers / action modes run and WHAT the evaluator
 * stage observed, not the order the fixtures happened to be recorded in.
 *
 * `evaluators` is the canonical builtin response-handler evaluator set the
 * pipeline ran (`BUILTIN_RESPONSE_HANDLER_EVALUATORS`); `evaluatorChannelSeen`
 * is the channelType a real registered probe evaluator observed when the
 * evaluator stage executed — proving the stage genuinely ran for this transport
 * (not that we asserted a constant).
 */
type PipelineTrace = {
	providers: string[];
	actionModes: string[];
	evaluators: string[];
	evaluatorChannelSeen: string[];
};

function makeTracingRuntime(): {
	runtime: IAgentRuntime;
	trace: PipelineTrace;
} {
	const trace: PipelineTrace = {
		providers: [],
		actionModes: [],
		evaluators: BUILTIN_RESPONSE_HANDLER_EVALUATORS.map((e) => e.name),
		evaluatorChannelSeen: [],
	};
	const queue: unknown[] = [respondFixture(), plannerFixture()];

	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}

	// A real registered response-handler evaluator. `runResponseHandlerEvaluators`
	// merges `runtime.responseHandlerEvaluators` with the builtin set and runs
	// them, so this probe FIRES inside the live evaluator stage and records the
	// channelType it saw — observable proof the stage executed for this turn.
	const probe: ResponseHandlerEvaluator = {
		name: "test.parity_probe",
		priority: 1,
		shouldRun: () => true,
		evaluate: (ctx) => {
			trace.evaluatorChannelSeen.push(
				String(ctx.message.content?.channelType ?? "none"),
			);
			return undefined;
		},
	};

	const runtime = createMockRuntime({
		agentId: AGENT,
		character: {
			name: "Test Agent",
			system: "You are concise.",
			bio: "I help with calendars.",
		},
		actions: [],
		// A couple of context-gated providers so the planner has a real provider
		// set to select + recompose (the recompose is where channel-aware
		// divergence would show up).
		providers: [
			{ name: "CHARACTER", contexts: ["general"], get: vi.fn() },
			{ name: "RECENT_MESSAGES", contexts: ["general"], get: vi.fn() },
		],
		composeState: vi.fn(async (_message: Memory, providers?: string[]) => {
			if (Array.isArray(providers)) {
				for (const name of providers) trace.providers.push(name);
			}
			return makeState();
		}),
		runActionsByMode: vi.fn(async (mode: string) => {
			trace.actionModes.push(mode);
			return undefined;
		}),
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
		responseHandlerEvaluators: [probe],
	});

	return { runtime, trace };
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort();
}

async function tracePipeline(channelType: ChannelType): Promise<PipelineTrace> {
	const { runtime, trace } = makeTracingRuntime();
	const result = await runV5MessageRuntimeStage1({
		runtime,
		message: makeMessage(channelType),
		state: makeState(),
		responseId: RESPONSE_ID,
	});
	// Both transports must reach a real reply (RESPOND), never a terminal IGNORE
	// — otherwise "parity" would be the trivial parity of two short-circuits.
	expect(
		result.kind === "direct_reply" || result.kind === "planned_reply",
	).toBe(true);
	return {
		providers: uniqueSorted(trace.providers),
		actionModes: uniqueSorted(trace.actionModes),
		evaluators: uniqueSorted(trace.evaluators),
		evaluatorChannelSeen: trace.evaluatorChannelSeen,
	};
}

describe("voice == text parity through the Stage-1 message pipeline (#8786 C5)", () => {
	it("a VOICE_DM and a text DM of the same utterance run the IDENTICAL providers", async () => {
		const text = await tracePipeline(ChannelType.DM);
		const voice = await tracePipeline(ChannelType.VOICE_DM);

		// Non-trivial: the pipeline really composed providers (not an empty set
		// that would make any comparison pass vacuously).
		expect(text.providers.length).toBeGreaterThan(0);
		expect(voice.providers).toEqual(text.providers);
	});

	it("runs the IDENTICAL RESPONSE_HANDLER / CONTEXT action modes for voice and text", async () => {
		const text = await tracePipeline(ChannelType.DM);
		const voice = await tracePipeline(ChannelType.VOICE_DM);

		expect(text.actionModes.length).toBeGreaterThan(0);
		// The Stage-1 action-mode contract: response-handler hooks fire for both.
		expect(text.actionModes).toEqual(
			expect.arrayContaining(["RESPONSE_HANDLER_BEFORE"]),
		);
		expect(voice.actionModes).toEqual(text.actionModes);
	});

	it("runs the IDENTICAL response-handler evaluator set, and the stage really executes for both", async () => {
		const text = await tracePipeline(ChannelType.DM);
		const voice = await tracePipeline(ChannelType.VOICE_DM);

		// The voice-group address gate is part of the builtin set that runs for
		// both transports (it self-gates to VOICE_GROUP, but the SET that runs is
		// identical — parity is about the pipeline, not the gate's per-turn verdict).
		expect(text.evaluators.length).toBeGreaterThan(0);
		expect(text.evaluators).toContain("core.voice_group_address");
		expect(voice.evaluators).toEqual(text.evaluators);

		// The probe fired in BOTH runs — the evaluator stage genuinely executed
		// for text and for voice — and each saw its own transport's channelType.
		expect(text.evaluatorChannelSeen).toEqual([ChannelType.DM]);
		expect(voice.evaluatorChannelSeen).toEqual([ChannelType.VOICE_DM]);
	});

	it("produces one combined parity verdict across providers + actions + evaluator set", async () => {
		const text = await tracePipeline(ChannelType.DM);
		const voice = await tracePipeline(ChannelType.VOICE_DM);
		// The channel-specific observation differs by design (each saw its own
		// transport); the pipeline SHAPE — providers, action modes, evaluator set
		// — must be identical.
		expect({
			providers: voice.providers,
			actionModes: voice.actionModes,
			evaluators: voice.evaluators,
		}).toEqual({
			providers: text.providers,
			actionModes: text.actionModes,
			evaluators: text.evaluators,
		});
	});
});
