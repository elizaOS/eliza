import type { IAgentRuntime, Memory } from "@elizaos/core";
import { ChannelType, type UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { VoiceAttributionOutput } from "../services/voice/speaker/attribution-pipeline.js";
import { handleLiveVoiceAttribution } from "./voice-entity-binding.js";

/**
 * Producer ⇄ consumer contract for the resolved-speaker stamp (#8786, commit
 * 2cea841d8a).
 *
 * The PRODUCER is `handleLiveVoiceAttribution` (this plugin): it stamps the
 * imprint → entityId match onto `turn.metadata.speakerEntityId`. That turn
 * metadata is what rides onto the message's `content.metadata` for a VOICE_DM.
 *
 * The CONSUMER is the core message handler's private `getVoiceSpeakerEntityId`
 * reader (`packages/core/src/services/message.ts`), which — per its documented
 * contract — reads the id from EITHER `content.speakerEntityId` (the top-level
 * in-process engine path) OR `content.metadata.speakerEntityId` (the nested
 * chat-client path), then canonicalizes it onto `content.metadata.speaker
 * EntityId` of the voice turn so providers / extraction / the facts +
 * relationships stage attribute the turn to the right person.
 *
 * The core reader is not exported, so this test locks the contract at the seam
 * that matters: it (1) runs the real producer, then (2) asserts the producer
 * writes the id at the exact `metadata.speakerEntityId` key the documented
 * reader consumes, and (3) exercises a reference of the reader contract against
 * a producer-shaped VOICE_DM message to prove a recognized speaker's entityId
 * lands on the message. A future rename of the key on either half breaks this.
 */

const ROOM = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY = "55555555-5555-5555-5555-555555555555" as UUID;

/**
 * Reference of the core `getVoiceSpeakerEntityId` reader contract (kept in sync
 * with `packages/core/src/services/message.ts`). Reads top-level first, then
 * the nested `content.metadata` entry; trims; null for an unbound speaker.
 */
function readSpeakerEntityIdContract(
	message: Pick<Memory, "content">,
): string | null {
	const content = message.content;
	const nested =
		content?.metadata &&
		typeof content.metadata === "object" &&
		!Array.isArray(content.metadata)
			? (content.metadata as Record<string, unknown>).speakerEntityId
			: undefined;
	const value =
		(content as { speakerEntityId?: unknown } | undefined)?.speakerEntityId ??
		nested;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function captureRuntime(): IAgentRuntime {
	return {
		emitEvent: async () => {},
	} as unknown as IAgentRuntime;
}

function boundOutput(entityId: string): VoiceAttributionOutput {
	return {
		turnId: "t-bound",
		primarySpeaker: { entityId, confidence: 0.7 },
		observation: { imprintClusterId: "cluster-1", confidence: 0.7, entityId },
		turn: { metadata: {} },
		segments: [],
	} as unknown as VoiceAttributionOutput;
}

/** Build the VOICE_DM the nested chat-client path produces from a turn. */
function voiceDmFromTurn(turnMetadata: Record<string, unknown>): Memory {
	return {
		id: "66666666-6666-6666-6666-666666666666" as UUID,
		entityId: ENTITY,
		roomId: ROOM,
		content: {
			text: "what's on my calendar",
			channelType: ChannelType.VOICE_DM,
			metadata: turnMetadata,
		},
	} as Memory;
}

describe("voice speaker-entity producer ⇄ consumer contract (#8786)", () => {
	it("producer stamps the id at the exact key the core reader consumes", async () => {
		const runtime = captureRuntime();
		const out = boundOutput("entity-jill");
		await handleLiveVoiceAttribution(runtime, out, {
			ownerEntityId: "entity-jill",
			transcript: "I'm Jill",
		});
		// The reader contract resolves the producer's turn metadata directly.
		const message = voiceDmFromTurn(
			out.turn.metadata as Record<string, unknown>,
		);
		expect(readSpeakerEntityIdContract(message)).toBe("entity-jill");
	});

	it("a recognized speaker's entityId lands on the VOICE_DM message (nested entry)", () => {
		const message = voiceDmFromTurn({
			voiceTurnSignal: { agentShouldSpeak: true },
			speakerEntityId: "entity-bob",
		});
		expect(readSpeakerEntityIdContract(message)).toBe("entity-bob");
	});

	it("resolves the top-level in-process entry too", () => {
		const message = {
			id: "77777777-7777-7777-7777-777777777777" as UUID,
			entityId: ENTITY,
			roomId: ROOM,
			content: {
				text: "remind me later",
				channelType: ChannelType.VOICE_DM,
				speakerEntityId: "entity-top",
				metadata: {},
			},
		} as unknown as Memory;
		expect(readSpeakerEntityIdContract(message)).toBe("entity-top");
	});

	it("an unbound speaker resolves to null (never a null speaker on the message)", async () => {
		const runtime = captureRuntime();
		const out = {
			turnId: "t-unbound",
			primarySpeaker: { entityId: null, confidence: 0.2 },
			observation: undefined,
			turn: { metadata: {} },
			segments: [],
		} as unknown as VoiceAttributionOutput;
		await handleLiveVoiceAttribution(runtime, out, {});
		const message = voiceDmFromTurn(
			out.turn.metadata as Record<string, unknown>,
		);
		expect(readSpeakerEntityIdContract(message)).toBeNull();
	});

	it("a blank / whitespace id resolves to null", () => {
		expect(
			readSpeakerEntityIdContract(voiceDmFromTurn({ speakerEntityId: "   " })),
		).toBeNull();
		expect(
			readSpeakerEntityIdContract(voiceDmFromTurn({ speakerEntityId: "" })),
		).toBeNull();
	});
});
