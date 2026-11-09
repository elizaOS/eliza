import { ChannelType, stringToUuid, type UUID } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TranscriptPrivacyService } from "./transcript-privacy";
import {
	TranscriptService,
	type TranscriptServiceRuntime,
} from "./transcript-service";
import { TranscriptStore } from "./transcript-store";

let runtime: ReturnType<typeof createSQLiteTestRuntime>;
const ownerId = stringToUuid("redacted-audio-owner");
const redactedViewerId = stringToUuid("redacted-audio-redacted-viewer");
const fullViewerId = stringToUuid("redacted-audio-full-viewer");
const worldId = stringToUuid("redacted-audio-world");
const roomId = stringToUuid("redacted-audio-room");

const SOURCE_FILE = `${"a".repeat(64)}.wav`;
const SOURCE_AUDIO = `/api/media/${SOURCE_FILE}`;
const REDACTED_AUDIO = `/api/media/${"b".repeat(64)}.wav`;

beforeAll(async () => {
	runtime = createSQLiteTestRuntime({
		character: { name: "RedactedAudio" },
		logLevel: "fatal",
	});
	await runtime.initialize({ skipMigrations: true });
	await runtime.createEntities([
		{ id: ownerId, agentId: runtime.agentId, names: ["Owner"] },
		{ id: redactedViewerId, agentId: runtime.agentId, names: ["Bob"] },
		{ id: fullViewerId, agentId: runtime.agentId, names: ["Carol"] },
	]);
	await runtime.createWorlds([
		{
			id: worldId,
			agentId: runtime.agentId,
			name: "W",
			messageServerId: worldId,
		},
	]);
	await runtime.createRooms([
		{
			id: roomId,
			agentId: runtime.agentId,
			worldId,
			name: "Meeting",
			source: "client_chat",
			type: ChannelType.GROUP,
		},
	]);
}, 120_000);

afterAll(async () => {
	await runtime?.stop();
});

/** The transcript routes hand the agent runtime to these services the same way. */
const serviceRuntime = () => runtime as TranscriptServiceRuntime;

const viewer = (requesterEntityId: UUID) => ({
	requesterEntityId,
	worldId,
	role: "USER" as const,
	isOwner: false,
});

/** A transcript with source audio, a verified redacted audio variant, and a
 *  redacted grant (plus a full grant) — the REDACT_TRANSCRIPT + share flow. */
async function sharedWithRedactedAudio(
	name: string,
): Promise<{ id: UUID; store: TranscriptStore }> {
	const id = stringToUuid(name);
	await new TranscriptService(serviceRuntime()).create({
		worldId,
		roomId,
		entityId: ownerId,
		transcript: {
			id,
			title: "Weekly sync",
			createdAt: 1_000,
			endedAt: 2_000,
			durationMs: 1_000,
			audioUrl: SOURCE_AUDIO,
			audioContentType: "audio/wav",
			segments: [
				{
					id: "s1",
					startMs: 0,
					endMs: 1_000,
					text: "Call me at 555-867-5309",
					words: [{ text: "Call", startMs: 0, endMs: 100 }],
				},
			],
			source: "meeting",
			scope: "owner-private",
			status: "ready",
			speakerCount: 1,
			metadata: { consent: { state: "granted" } },
		},
	});
	const store = new TranscriptStore(runtime);
	await store.createRedactedVariant({
		originalId: id,
		redactedBy: ownerId,
		redactedAudioUrl: REDACTED_AUDIO,
	});
	await store.share({
		transcriptId: id,
		entityId: redactedViewerId,
		mode: "redacted",
	});
	await store.share({ transcriptId: id, entityId: fullViewerId, mode: "full" });
	return { id, store };
}

async function redactedViewerAudio(store: TranscriptStore, id: UUID) {
	const served = await store.get(id, viewer(redactedViewerId));
	const listed = await store.list(undefined, 100, viewer(redactedViewerId));
	return {
		audioUrl: served?.audioUrl,
		hasAudio: listed.find((summary) => summary.id === id)?.hasAudio,
	};
}

describe("redacted variant audio follows the owner's source-audio setting", () => {
	it("keeps the redacted audio while the owner has not restricted source audio", async () => {
		const { id, store } = await sharedWithRedactedAudio(
			"redacted-audio-default",
		);
		expect(await redactedViewerAudio(store, id)).toEqual({
			audioUrl: REDACTED_AUDIO,
			hasAudio: true,
		});
	});

	it("withholds it from every granted viewer once source audio sharing is disabled", async () => {
		const { id, store } = await sharedWithRedactedAudio(
			"redacted-audio-disabled",
		);
		await new TranscriptPrivacyService(serviceRuntime()).updateArtifactSharing(
			id,
			{
				sourceAudio: "disabled",
			},
		);
		const fullViewer = await store.get(id, viewer(fullViewerId));
		expect(fullViewer?.audioUrl).toBeUndefined();
		expect(await redactedViewerAudio(store, id)).toEqual({
			audioUrl: undefined,
			hasAudio: false,
		});
	});

	it("withholds it when the owner keeps source audio owner-private", async () => {
		const { id, store } = await sharedWithRedactedAudio(
			"redacted-audio-owner-private",
		);
		await new TranscriptPrivacyService(serviceRuntime()).updateArtifactSharing(
			id,
			{
				sourceAudio: "owner_private",
			},
		);
		expect(await redactedViewerAudio(store, id)).toEqual({
			audioUrl: undefined,
			hasAudio: false,
		});
	});

	it("withholds it once the owner deletes the source audio", async () => {
		const { id, store } = await sharedWithRedactedAudio(
			"redacted-audio-deleted",
		);
		await store.markSourceAudioDeletePending({
			transcriptId: id,
			fileName: SOURCE_FILE,
		});
		await store.markSourceAudioDeleted(id);
		expect(await redactedViewerAudio(store, id)).toEqual({
			audioUrl: undefined,
			hasAudio: false,
		});
	});
});
