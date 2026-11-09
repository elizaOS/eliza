import { ChannelType, stringToUuid } from "@elizaos/core";
import type { Transcript } from "@elizaos/core/protocol";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	TranscriptService,
	type TranscriptServiceRuntime,
} from "./transcript-service";
import { TranscriptStore } from "./transcript-store";

let runtime: ReturnType<typeof createSQLiteTestRuntime>;
const ownerId = stringToUuid("redacted-words-owner");
const viewerId = stringToUuid("redacted-words-viewer");
const worldId = stringToUuid("redacted-words-world");
const roomId = stringToUuid("redacted-words-room");

beforeAll(async () => {
	runtime = createSQLiteTestRuntime({
		character: { name: "RedactedWords" },
		logLevel: "fatal",
	});
	await runtime.initialize({ skipMigrations: true });
	await runtime.createEntities([
		{ id: ownerId, agentId: runtime.agentId, names: ["Owner"] },
		{ id: viewerId, agentId: runtime.agentId, names: ["Viewer"] },
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

function meetingTranscript(id: Transcript["id"]): Transcript {
	const text = "Please call Alice Johnson at 555 867 5309";
	return {
		id,
		title: "Weekly sync",
		createdAt: 1_000,
		endedAt: 2_000,
		durationMs: 1_500,
		segments: [
			{
				id: "s1",
				speakerLabel: "Speaker 1",
				startMs: 0,
				endMs: 1_500,
				text,
				words: text.split(" ").map((word, index) => ({
					text: word,
					startMs: index * 100,
					endMs: index * 100 + 100,
				})),
			},
		],
		source: "meeting",
		scope: "owner-private",
		status: "ready",
		speakerCount: 1,
		metadata: {
			consent: { state: "granted" },
			participants: [{ entityId: viewerId, displayName: "Alice Johnson" }],
		},
	};
}

describe("redacted transcript variant word timings", () => {
	it("withholds every word of a multi-word value that the segment text redacts", async () => {
		const id = stringToUuid("redacted-words-transcript");
		await new TranscriptService(runtime as TranscriptServiceRuntime).create({
			worldId,
			roomId,
			entityId: ownerId,
			transcript: meetingTranscript(id),
		});
		const store = new TranscriptStore(runtime);
		await store.createRedactedVariant({ originalId: id, redactedBy: ownerId });
		await store.share({
			transcriptId: id,
			entityId: viewerId,
			mode: "redacted",
			grantedBy: ownerId,
		});

		const served = await store.get(id, {
			requesterEntityId: viewerId,
			worldId,
			role: "USER",
			isOwner: false,
		});

		expect(served?.redacted).toBe(true);
		const segment = served?.segments[0];
		expect(segment?.text).not.toMatch(/Alice|Johnson|5309/);
		const words = segment?.words.map((word) => word.text) ?? [];
		expect(words).toHaveLength(8);
		expect(words.join(" ")).not.toMatch(/Alice|Johnson|555|867|5309/);
		expect(words.slice(0, 2)).toEqual(["Please", "call"]);
		expect(words[4]).toBe("at");
	});
});
