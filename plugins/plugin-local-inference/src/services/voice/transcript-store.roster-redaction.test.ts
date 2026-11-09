/**
 * The redacted variant pseudonymizes participant roster names through the
 * core gazetteer. Its corpus starts with the transcript title, so a Turkish
 * title that begins with "İ" used to shift every roster match after it and the
 * stored variant kept the real name.
 */
import { stringToUuid, type UUID } from "@elizaos/core";
import type { Transcript } from "@elizaos/core/protocol";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptStore } from "./transcript-store";

const runtimes: Array<{ stop(): Promise<void>; close(): Promise<void> }> = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) {
		await runtime.stop();
		await runtime.close();
	}
});

function meetingTranscript(id: UUID, title: string, text: string): Transcript {
	return {
		id,
		title,
		createdAt: 1_700_000_000_000,
		endedAt: 1_700_000_060_000,
		durationMs: 60_000,
		segments: [
			{
				id: `${id}-s1`,
				speakerLabel: "Speaker 1",
				startMs: 0,
				endMs: 5_000,
				text,
				words: [],
			},
		],
		source: "meeting",
		scope: "owner-private",
		status: "ready",
		speakerCount: 1,
		metadata: { participants: [{ displayName: "Ayşe Kaya" }] },
	};
}

async function redactedSegmentText(
	title: string,
	text: string,
): Promise<string> {
	const runtime = createSQLiteTestRuntime({
		character: { name: "RosterRedactionTest" },
		logLevel: "fatal",
	});
	await runtime.initialize({ skipMigrations: true });
	runtimes.push(runtime);
	const store = new TranscriptStore(runtime);
	const id = stringToUuid(`roster-redaction:${title}`) as UUID;
	await store.create({
		roomId: stringToUuid("roster-redaction-room") as UUID,
		entityId: stringToUuid("roster-redaction-owner") as UUID,
		transcript: meetingTranscript(id, title, text),
	});
	const variant = await store.createRedactedVariant({
		originalId: id,
		seed: "roster-redaction",
		nowMs: 1_700_000_100_000,
	});
	return variant.segments[0]?.text ?? "";
}

describe("TranscriptStore redacted variant with the participant roster", () => {
	it("pseudonymizes the roster name under an English title", async () => {
		const text = await redactedSegmentText(
			"Weekly sync",
			"Thanks, Ayşe Kaya, for the update.",
		);

		expect(text).not.toContain("Ayşe Kaya");
	}, 60_000);

	it("pseudonymizes the roster name under a title that starts with İ", async () => {
		const text = await redactedSegmentText(
			"İstanbul ekibi haftalık toplantı",
			"Teşekkürler Ayşe Kaya, güncelleme için.",
		);

		expect(text).not.toContain("Ayşe Kaya");
		expect(text).toMatch(/^Teşekkürler .+, güncelleme için\.$/);
	}, 60_000);
});
