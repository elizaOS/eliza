/** Unit tests for `transcriptKnowledgePayload` shaping transcripts into knowledge items. Deterministic. */
import type { Transcript } from "@elizaos/shared/transcripts";
import { describe, expect, it } from "vitest";
import {
	TRANSCRIPT_DOCUMENT_TAG,
	transcriptKnowledgePayload,
} from "./transcript-knowledge";

const transcript: Transcript = {
	id: "t-123",
	title: "Standup — June 20",
	createdAt: 1000,
	endedAt: 5000,
	durationMs: 4000,
	audioUrl: "/api/media/abc.wav",
	source: "voice-session",
	scope: "owner-private",
	status: "ready",
	speakerCount: 2,
	segments: [
		{
			id: "s1",
			speakerLabel: "Alice",
			startMs: 0,
			endMs: 1000,
			text: "ship the build",
			words: [],
		},
		{
			id: "s2",
			speakerLabel: "Bob",
			startMs: 1200,
			endMs: 2000,
			text: "on it",
			words: [],
		},
	],
};

describe("transcriptKnowledgePayload", () => {
	it("builds a searchable text document linked back to the transcript", () => {
		const p = transcriptKnowledgePayload(transcript);
		// Body is the speaker-labeled plain text (what gets embedded + searched).
		expect(p.content).toBe("Alice: ship the build\nBob: on it");
		expect(p.contentType).toBe("text/plain");
		expect(p.scope).toBe("owner-private");
		// Slugified filename.
		expect(p.filename).toBe("standup-june-20.txt");
		// Tagged + linked back to the rich record.
		expect(p.metadata.tags).toEqual([TRANSCRIPT_DOCUMENT_TAG]);
		expect(p.metadata.source).toBe(TRANSCRIPT_DOCUMENT_TAG);
		expect(p.metadata.transcriptId).toBe("t-123");
		expect(p.metadata.title).toBe("Standup — June 20");
		expect(p.metadata.audioUrl).toBe("/api/media/abc.wav");
		expect(p.metadata.durationMs).toBe(4000);
		expect(p.metadata.speakerCount).toBe(2);
		expect(p.metadata.textBacked).toBe(true);
	});

	it("omits audioUrl when the transcript has no audio, and slugs an empty title", () => {
		const p = transcriptKnowledgePayload({
			...transcript,
			title: "  ",
			audioUrl: undefined,
		});
		expect(p.metadata.audioUrl).toBeUndefined();
		expect(p.filename).toBe("transcript.txt");
	});
});
