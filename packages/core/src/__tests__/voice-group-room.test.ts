/**
 * Multi-agent / multi-speaker voice-room turn-taking (#8786 + #8785).
 *
 * Contract: in a VOICE_GROUP, an agent DEFERS (IGNORE) when the turn is
 * explicitly addressed to another named participant and not to this agent — so
 * across ≥3 participants only the addressed agent replies. Undirected turns are
 * left to normal shouldRespond (no suppression).
 */

import { describe, expect, it } from "vitest";
import { parseMessageHandlerOutput } from "../runtime/message-handler";
import type { ResponseHandlerEvaluatorContext } from "../runtime/response-handler-evaluators";
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "../services/message";
import type { Memory } from "../types/memory";
import { ChannelType, type UUID } from "../types/primitives";

const ROOM = "11111111-1111-1111-1111-111111111111" as UUID;
const SPEAKER = "22222222-2222-2222-2222-222222222222" as UUID;

function voiceGroupMsg(): Memory {
	return {
		id: "33333333-3333-3333-3333-333333333333" as UUID,
		entityId: SPEAKER,
		roomId: ROOM,
		content: {
			text: "eliza what's the time",
			channelType: ChannelType.VOICE_GROUP,
		},
	} as Memory;
}

/** A context for an agent named `agentName`, with an extracted `addressedTo`. */
function ctxFor(
	agentName: string,
	addressedTo: string[],
	message: Memory = voiceGroupMsg(),
): ResponseHandlerEvaluatorContext {
	return {
		runtime: {
			agentId: `agent-${agentName.toLowerCase()}` as UUID,
			character: { name: agentName },
		},
		message,
		messageHandler: { processMessage: "RESPOND", extract: { addressedTo } },
	} as unknown as ResponseHandlerEvaluatorContext;
}

const gate = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
	(e) => e.name === "core.voice_group_address",
);

describe("core.voice_group_address (multi-agent voice room)", () => {
	it("is registered", () => {
		expect(gate).toBeDefined();
	});

	it("only the addressed agent replies across 3 participants", async () => {
		if (!gate) throw new Error("missing");
		// "Eliza, what's the time" → addressedTo=["Eliza"] in a room with 3 agents.
		const addressed = ctxFor("Eliza", ["Eliza"]);
		const otherA = ctxFor("Claude", ["Eliza"]);
		const otherB = ctxFor("Aria", ["Eliza"]);

		// The addressed agent is NOT suppressed → it replies normally.
		expect(await gate.shouldRun(addressed)).toBe(false);
		// The two un-addressed agents defer.
		expect(await gate.shouldRun(otherA)).toBe(true);
		expect((await gate.evaluate(otherA)).processMessage).toBe("IGNORE");
		expect(await gate.shouldRun(otherB)).toBe(true);
		expect((await gate.evaluate(otherB)).processMessage).toBe("IGNORE");
	});

	it("an undirected turn (empty addressedTo) is left to normal shouldRespond", async () => {
		if (!gate) throw new Error("missing");
		expect(await gate.shouldRun(ctxFor("Eliza", []))).toBe(false);
		expect(await gate.shouldRun(ctxFor("Claude", []))).toBe(false);
	});

	it("a turn addressed to several agents including self does not suppress self", async () => {
		if (!gate) throw new Error("missing");
		expect(await gate.shouldRun(ctxFor("Eliza", ["Eliza", "Claude"]))).toBe(
			false,
		);
		// But an agent named neither still defers.
		expect(await gate.shouldRun(ctxFor("Aria", ["Eliza", "Claude"]))).toBe(
			true,
		);
	});

	it("matches the agent by id as well as by character name", async () => {
		if (!gate) throw new Error("missing");
		// addressedTo can carry the resolved agent id.
		expect(await gate.shouldRun(ctxFor("Eliza", ["agent-eliza"]))).toBe(false);
	});

	it("does not run for VOICE_DM (single-party) or text messages", async () => {
		if (!gate) throw new Error("missing");
		const dm = {
			...voiceGroupMsg(),
			content: { text: "hi claude", channelType: ChannelType.VOICE_DM },
		} as Memory;
		expect(await gate.shouldRun(ctxFor("Eliza", ["Claude"], dm))).toBe(false);
	});

	it("fails open (no suppression) when the agent cannot be identified", async () => {
		if (!gate) throw new Error("missing");
		const ctx = {
			runtime: { agentId: "", character: {} },
			message: voiceGroupMsg(),
			messageHandler: {
				processMessage: "RESPOND",
				extract: { addressedTo: ["Eliza"] },
			},
		} as unknown as ResponseHandlerEvaluatorContext;
		expect(await gate.shouldRun(ctx)).toBe(false);
	});
});

/**
 * Integration: drive the REAL Stage-1 parser (`parseMessageHandlerOutput`) so
 * `addressedTo` is *derived* from a model HANDLE_RESPONSE envelope rather than
 * hand-fed, then feed the parsed extract to the gate across ≥3 agents. This
 * closes the parse→decision chain the unit tests above bypass; the only step
 * not exercised here is the live model producing the envelope (gated, real-model
 * lane). The runtime builds `messageHandler.{processMessage,extract}` from
 * exactly this parser output, so the context mapping mirrors production.
 */
describe("core.voice_group_address — parse→gate integration (#8786)", () => {
	/** The model's Stage-1 envelope for "Eliza, what's the time" in a 3-agent
	 *  room: RESPOND, with the address resolved to Eliza. */
	const ADDRESSED_ENVELOPE = JSON.stringify({
		shouldRespond: "RESPOND",
		replyText: "It is noon.",
		contexts: ["simple"],
		addressedTo: ["Eliza"],
	});

	function ctxFromEnvelope(
		agentName: string,
		envelope: string,
	): ResponseHandlerEvaluatorContext {
		const parsed = parseMessageHandlerOutput(envelope);
		if (!parsed) throw new Error("envelope failed to parse");
		return {
			runtime: {
				agentId: `agent-${agentName.toLowerCase()}` as UUID,
				character: { name: agentName },
			},
			message: voiceGroupMsg(),
			messageHandler: {
				processMessage: parsed.processMessage,
				extract: parsed.extract ?? {},
			},
		} as unknown as ResponseHandlerEvaluatorContext;
	}

	it("derives addressedTo from the real parse, then only the addressed agent replies (≥3 agents)", async () => {
		if (!gate) throw new Error("missing");
		// The parser actually produced the addressedTo the gate consumes.
		const parsed = parseMessageHandlerOutput(ADDRESSED_ENVELOPE);
		expect(parsed?.processMessage).toBe("RESPOND");
		expect(parsed?.extract?.addressedTo).toEqual(["Eliza"]);

		// Eliza (addressed) is not suppressed; Claude + Aria defer.
		expect(
			await gate.shouldRun(ctxFromEnvelope("Eliza", ADDRESSED_ENVELOPE)),
		).toBe(false);
		for (const other of ["Claude", "Aria"]) {
			const ctx = ctxFromEnvelope(other, ADDRESSED_ENVELOPE);
			expect(await gate.shouldRun(ctx)).toBe(true);
			expect((await gate.evaluate(ctx)).processMessage).toBe("IGNORE");
		}
	});

	it("an undirected envelope (no addressedTo) leaves every agent to normal shouldRespond", async () => {
		if (!gate) throw new Error("missing");
		const undirected = JSON.stringify({
			shouldRespond: "RESPOND",
			replyText: "sure",
			contexts: ["simple"],
		});
		// No addressedTo in the envelope → parser omits it → gate fails open.
		expect(parseMessageHandlerOutput(undirected)?.extract?.addressedTo).toBe(
			undefined,
		);
		expect(await gate.shouldRun(ctxFromEnvelope("Eliza", undirected))).toBe(
			false,
		);
		expect(await gate.shouldRun(ctxFromEnvelope("Aria", undirected))).toBe(
			false,
		);
	});
});
