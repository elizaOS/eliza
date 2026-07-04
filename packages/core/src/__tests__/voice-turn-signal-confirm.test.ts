/**
 * The `core.voice_turn_signal_confirm` builtin response-handler evaluator: the
 * positive-decision path that promotes a Stage-1 IGNORE to RESPOND on an explicit
 * server agentShouldSpeak signal, while never overriding a STOP, an existing
 * RESPOND, or a user-next turn. Deterministic — driven with hand-built voice
 * Memory + handler-decision contexts, no model.
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

function ctx(
	message: Memory,
	processMessage: "RESPOND" | "IGNORE" | "STOP",
): ResponseHandlerEvaluatorContext {
	return {
		message,
		messageHandler: { processMessage },
	} as unknown as ResponseHandlerEvaluatorContext;
}

const confirm = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
	(e) => e.name === "core.voice_turn_signal_confirm",
);

describe("core.voice_turn_signal_confirm (server positive decision)", () => {
	it("is registered", () => {
		expect(confirm).toBeDefined();
	});

	it("promotes an IGNORE to RESPOND on an explicit agentShouldSpeak signal", async () => {
		if (!confirm) throw new Error("missing");
		const message = voiceMsg({
			agentShouldSpeak: true,
			nextSpeaker: "agent",
			endOfTurnProbability: 0.9,
		});
		expect(await confirm.shouldRun(ctx(message, "IGNORE"))).toBe(true);
		const result = await confirm.evaluate(ctx(message, "IGNORE"));
		expect(result.processMessage).toBe("RESPOND");
	});

	it("does NOT override an explicit STOP or an already-RESPOND decision", async () => {
		if (!confirm) throw new Error("missing");
		const message = voiceMsg({ agentShouldSpeak: true });
		expect(await confirm.shouldRun(ctx(message, "STOP"))).toBe(false);
		expect(await confirm.shouldRun(ctx(message, "RESPOND"))).toBe(false);
	});

	it("does not fire without the explicit agentShouldSpeak signal", async () => {
		if (!confirm) throw new Error("missing");
		// A bare end-of-turn signal is not a positive confirm.
		expect(
			await confirm.shouldRun(
				ctx(voiceMsg({ endOfTurnProbability: 0.9 }), "IGNORE"),
			),
		).toBe(false);
		// user-next overrides confirm.
		expect(
			await confirm.shouldRun(
				ctx(
					voiceMsg({ agentShouldSpeak: true, nextSpeaker: "user" }),
					"IGNORE",
				),
			),
		).toBe(false);
	});
});
