/**
 * The `core.voice_turn_signal` suppression gate (#8786): the server veto that
 * blocks a voice reply when semantic turn-taking says the next speaker is not the
 * agent (agentShouldSpeak false, next speaker user, or end-of-turn probability
 * below 0.4), and only on voice channels carrying the signal. Deterministic — the
 * builtin evaluator runs against hand-built Memory + handler-decision contexts,
 * no model.
 */
import { describe, expect, it } from "vitest";
import type { ResponseHandlerEvaluatorContext } from "../runtime/response-handler-evaluators";
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "../services/message";
import type { Memory } from "../types/memory";
import { ChannelType, type UUID } from "../types/primitives";

const ROOM = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY = "22222222-2222-2222-2222-222222222222" as UUID;

function voiceMsg(signal: Record<string, unknown>): Memory {
	return {
		id: "33333333-3333-3333-3333-333333333333" as UUID,
		entityId: ENTITY,
		roomId: ROOM,
		content: {
			text: "eliza what's the time",
			channelType: ChannelType.VOICE_DM,
			metadata: { voiceTurnSignal: signal },
		},
	} as Memory;
}

function textMsg(signal: Record<string, unknown>): Memory {
	return {
		id: "44444444-4444-4444-4444-444444444444" as UUID,
		entityId: ENTITY,
		roomId: ROOM,
		content: {
			text: "hello",
			channelType: ChannelType.DM,
			metadata: { voiceTurnSignal: signal },
		},
	} as Memory;
}

function ctx(
	message: Memory,
	processMessage: "RESPOND" | "IGNORE" | "STOP" = "RESPOND",
): ResponseHandlerEvaluatorContext {
	return {
		message,
		messageHandler: { processMessage },
	} as unknown as ResponseHandlerEvaluatorContext;
}

const suppress = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
	(e) => e.name === "core.voice_turn_signal",
);

describe("core.voice_turn_signal (server suppression gate)", () => {
	it("is registered", () => {
		expect(suppress).toBeDefined();
	});

	it("suppresses when agentShouldSpeak === false", async () => {
		if (!suppress) throw new Error("missing");
		const message = voiceMsg({ agentShouldSpeak: false });
		expect(await suppress.shouldRun(ctx(message))).toBe(true);
		const result = await suppress.evaluate(ctx(message));
		expect(result.processMessage).toBe("IGNORE");
		expect(result.clearReply).toBe(true);
		expect(result.requiresTool).toBe(false);
	});

	it("suppresses when the next speaker is the user", async () => {
		if (!suppress) throw new Error("missing");
		expect(
			await suppress.shouldRun(ctx(voiceMsg({ nextSpeaker: "user" }))),
		).toBe(true);
	});

	it("suppresses when end-of-turn probability is below 0.4 (user still talking)", async () => {
		if (!suppress) throw new Error("missing");
		expect(
			await suppress.shouldRun(ctx(voiceMsg({ endOfTurnProbability: 0.39 }))),
		).toBe(true);
		// 0.4 is the boundary — NOT suppressed.
		expect(
			await suppress.shouldRun(ctx(voiceMsg({ endOfTurnProbability: 0.4 }))),
		).toBe(false);
	});

	it("vetoes even an explicit RESPOND (suppression-only: it can only veto)", async () => {
		if (!suppress) throw new Error("missing");
		// shouldRun ignores the handler decision — a confident user-next turn is
		// suppressed regardless of the Stage-1 RESPOND.
		const message = voiceMsg({ nextSpeaker: "user" });
		expect(await suppress.shouldRun(ctx(message, "RESPOND"))).toBe(true);
	});

	it("does NOT suppress a clear agent-next turn", async () => {
		if (!suppress) throw new Error("missing");
		expect(
			await suppress.shouldRun(
				ctx(
					voiceMsg({
						agentShouldSpeak: true,
						nextSpeaker: "agent",
						endOfTurnProbability: 0.9,
					}),
				),
			),
		).toBe(false);
	});

	it("does NOT run on a non-voice (text) channel even with a suppressing signal", async () => {
		if (!suppress) throw new Error("missing");
		expect(
			await suppress.shouldRun(ctx(textMsg({ nextSpeaker: "user" }))),
		).toBe(false);
	});

	it("does NOT run when no voiceTurnSignal metadata is present", async () => {
		if (!suppress) throw new Error("missing");
		const bare = {
			id: "55555555-5555-5555-5555-555555555555" as UUID,
			entityId: ENTITY,
			roomId: ROOM,
			content: { text: "hi", channelType: ChannelType.VOICE_DM },
		} as Memory;
		expect(await suppress.shouldRun(ctx(bare))).toBe(false);
	});
});
