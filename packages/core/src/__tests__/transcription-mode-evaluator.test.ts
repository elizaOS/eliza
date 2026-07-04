/**
 * Transcription-mode reply suppression: the transcriptionModeActive flag reader
 * (client-transport metadata path and in-process top-level path) and the
 * `core.transcription_mode` builtin response-handler evaluator that turns a
 * flagged turn into IGNORE + clearReply. Deterministic — the evaluator runs
 * against hand-built Memory, no model.
 */
import { describe, expect, it } from "vitest";
import type { ResponseHandlerEvaluatorContext } from "../runtime/response-handler-evaluators";
import {
	BUILTIN_RESPONSE_HANDLER_EVALUATORS,
	transcriptionModeActive,
} from "../services/message";
import type { Memory } from "../types/memory";
import { ChannelType, type UUID } from "../types/primitives";

const ROOM = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY = "22222222-2222-2222-2222-222222222222" as UUID;

function msg(content: Record<string, unknown>): Memory {
	return {
		id: "33333333-3333-3333-3333-333333333333" as UUID,
		entityId: ENTITY,
		roomId: ROOM,
		content: { text: "note to self", ...content },
	} as Memory;
}

function ctx(message: Memory): ResponseHandlerEvaluatorContext {
	// core.transcription_mode only reads `message`; the rest is unused.
	return { message } as unknown as ResponseHandlerEvaluatorContext;
}

describe("transcriptionModeActive", () => {
	it("reads the flag from content.metadata (client transport path)", () => {
		expect(
			transcriptionModeActive(msg({ metadata: { transcriptionMode: true } })),
		).toBe(true);
	});
	it("reads the flag from content top-level (in-process path)", () => {
		expect(transcriptionModeActive(msg({ transcriptionMode: true }))).toBe(
			true,
		);
	});
	it("is false without the flag, and for a non-true value", () => {
		expect(transcriptionModeActive(msg({}))).toBe(false);
		expect(
			transcriptionModeActive(msg({ metadata: { transcriptionMode: "yes" } })),
		).toBe(false);
		expect(
			transcriptionModeActive(msg({ metadata: { transcriptionMode: false } })),
		).toBe(false);
	});
});

describe("core.transcription_mode evaluator", () => {
	const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
		(e) => e.name === "core.transcription_mode",
	);

	it("is registered as a builtin response-handler evaluator", () => {
		expect(evaluator).toBeDefined();
	});

	it("runs only when transcription mode is active (any channel)", async () => {
		if (!evaluator) throw new Error("evaluator missing");
		// DM channel with the flag → suppress.
		expect(
			await evaluator.shouldRun(
				ctx(
					msg({
						channelType: ChannelType.DM,
						metadata: { transcriptionMode: true },
					}),
				),
			),
		).toBe(true);
		// VOICE_DM channel with the flag → suppress.
		expect(
			await evaluator.shouldRun(
				ctx(
					msg({ channelType: ChannelType.VOICE_DM, transcriptionMode: true }),
				),
			),
		).toBe(true);
		// No flag → does not run (agent replies normally).
		expect(
			await evaluator.shouldRun(ctx(msg({ channelType: ChannelType.DM }))),
		).toBe(false);
	});

	it("suppresses the reply but keeps the turn (IGNORE + clearReply, no tool)", async () => {
		if (!evaluator) throw new Error("evaluator missing");
		const result = await evaluator.evaluate(
			ctx(msg({ metadata: { transcriptionMode: true } })),
		);
		expect(result.processMessage).toBe("IGNORE");
		expect(result.clearReply).toBe(true);
		expect(result.requiresTool).toBe(false);
	});
});
