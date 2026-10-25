/**
 * Tests that `handleLiveVoiceAttribution` emits `VOICE_TURN_OBSERVED` carrying
 * the turn transcript for the merge engine. Uses a fake runtime event sink; no
 * real attribution pipeline or model runs.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { EventType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { VoiceAttributionOutput } from "../services/voice/speaker/attribution-pipeline.js";
import { handleLiveVoiceAttribution } from "./voice-entity-binding.js";

/** Minimal attribution output with an observation (drives the emit path). */
function output(): VoiceAttributionOutput {
	return {
		turnId: "t1",
		primarySpeaker: { entityId: "entity-jill", confidence: 0.6 },
		observation: {
			imprintClusterId: "cluster-1",
			confidence: 0.6,
			entityId: "entity-jill",
		},
		turn: { metadata: {} },
		segments: [],
	} as unknown as VoiceAttributionOutput;
}

function captureRuntime(): {
	runtime: IAgentRuntime;
	events: Array<{ type: unknown; payload: Record<string, unknown> }>;
} {
	const events: Array<{ type: unknown; payload: Record<string, unknown> }> = [];
	const runtime = {
		emitEvent: async (type: unknown, payload: Record<string, unknown>) => {
			events.push({ type, payload });
		},
	} as unknown as IAgentRuntime;
	return { runtime, events };
}

describe("handleLiveVoiceAttribution — transcript carry (#8786)", () => {
	it("rides the real transcript on VOICE_TURN_OBSERVED when provided", async () => {
		const { runtime, events } = captureRuntime();
		await handleLiveVoiceAttribution(runtime, output(), {
			ownerEntityId: "entity-jill",
			transcript: "I'm Jill",
		});
		const observed = events.find(
			(e) => e.type === EventType.VOICE_TURN_OBSERVED,
		);
		expect(observed).toBeDefined();
		// Was hardcoded "" — the merge engine's name extraction needs the text.
		expect(observed?.payload.text).toBe("I'm Jill");
	});

	it("falls back to '' for diarization-only callers (no transcript)", async () => {
		const { runtime, events } = captureRuntime();
		await handleLiveVoiceAttribution(runtime, output(), {
			ownerEntityId: "entity-jill",
		});
		const observed = events.find(
			(e) => e.type === EventType.VOICE_TURN_OBSERVED,
		);
		expect(observed?.payload.text).toBe("");
	});

	it("also stamps the transcript onto the synthesized turn signal", async () => {
		const { runtime } = captureRuntime();
		const signal = await handleLiveVoiceAttribution(runtime, output(), {
			ownerEntityId: "entity-jill",
			transcript: "Jill is my wife",
		});
		expect(signal.transcript).toBe("Jill is my wife");
	});

	it("stamps the resolved speaker entityId onto the turn metadata (#8786)", async () => {
		const { runtime } = captureRuntime();
		const out = output();
		await handleLiveVoiceAttribution(runtime, out, {
			ownerEntityId: "entity-jill",
			transcript: "I'm Jill",
		});
		// The imprint → entityId match rides on the message so providers/extraction
		// attribute the turn to the right person, not just the EOT gate.
		const meta = out.turn.metadata as Record<string, unknown>;
		expect(meta.speakerEntityId).toBe("entity-jill");
		expect(meta.voiceTurnSignal).toBeDefined();
	});

	it("omits speakerEntityId for an unbound speaker (never writes a null speaker)", async () => {
		const { runtime } = captureRuntime();
		const out = {
			turnId: "t2",
			primarySpeaker: { entityId: null, confidence: 0.2 },
			observation: undefined,
			turn: { metadata: {} },
			segments: [],
		} as unknown as VoiceAttributionOutput;
		await handleLiveVoiceAttribution(runtime, out, {});
		const meta = out.turn.metadata as Record<string, unknown>;
		expect(meta.speakerEntityId).toBeUndefined();
		expect(meta.voiceTurnSignal).toBeDefined();
	});
});
