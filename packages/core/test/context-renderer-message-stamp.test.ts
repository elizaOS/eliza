/**
 * The time stamp on a historical message. A hosted model that spends a token
 * on every digit paid about 33 tokens for each ISO stamp with milliseconds and
 * an offset; the stamp states the local date and the minute, and nothing
 * parses it back.
 */
import { describe, expect, it } from "vitest";
import type { ContextEvent } from "../src/runtime/context-object.ts";
import {
	renderContextObject,
	segmentBlock,
} from "../src/runtime/context-renderer.ts";

function prior(id: string, at: number, text: string): ContextEvent {
	return {
		id: `history:${id}`,
		type: "segment",
		source: "prior-dialogue",
		createdAt: at,
		segment: {
			id: `history:${id}`,
			label: "prior_message:user",
			content: `user: ${text}`,
			stable: false,
		},
	};
}

function transcript(events: ContextEvent[], zone?: string): string[] {
	return renderContextObject({
		id: "turn",
		metadata: zone ? { displayTimeZone: zone } : {},
		events: [
			...events,
			{
				id: "current",
				type: "message",
				createdAt: Date.parse("2026-11-20T21:19:11.219Z"),
				message: { id: "current", role: "user", content: "And now?" },
			},
		],
	})
		.promptSegments.filter((segment) => segment.label === "prior_message:user")
		.map(segmentBlock);
}

describe("historical message stamps", () => {
	it("states the local date and minute, without seconds, milliseconds or an offset", () => {
		expect(
			transcript(
				[
					prior(
						"a",
						Date.parse("2026-11-20T04:59:59.999Z"),
						"Before midnight.",
					),
					prior("b", Date.parse("2026-11-20T21:18:13.690Z"), "Open Messages."),
				],
				"America/New_York",
			),
		).toEqual([
			"[message_at=11-19 23:59] user: Before midnight.",
			"[message_at=11-20 16:18] user: Open Messages.",
		]);
	});

	it("prints the year of a message from another year than the newest event", () => {
		expect(
			transcript(
				[
					prior("old", Date.parse("2025-11-20T21:18:13.690Z"), "Last year."),
					// Still 2025 where the owner is, already 2026 in UTC.
					prior(
						"eve",
						Date.parse("2026-01-01T04:30:00.000Z"),
						"New Year's Eve.",
					),
					prior("new", Date.parse("2026-01-01T05:30:00.000Z"), "This year."),
				],
				"America/New_York",
			),
		).toEqual([
			"[message_at=2025-11-20 16:18] user: Last year.",
			"[message_at=2025-12-31 23:30] user: New Year's Eve.",
			"[message_at=01-01 00:30] user: This year.",
		]);
	});

	it("marks UTC when no display zone is usable", () => {
		const at = Date.parse("2026-11-20T21:18:13.690Z");
		expect(transcript([prior("a", at, "Open Messages.")])).toEqual([
			"[message_at=11-20 21:18Z] user: Open Messages.",
		]);
		expect(transcript([prior("a", at, "Open Messages.")], "Not/AZone")).toEqual(
			["[message_at=11-20 21:18Z] user: Open Messages."],
		);
	});

	it("adds the offset only in the hour a zone's clocks repeat", () => {
		expect(
			transcript(
				[
					prior("first", Date.parse("2026-11-01T05:30:00Z"), "First 1:30."),
					prior("second", Date.parse("2026-11-01T06:30:00Z"), "Second 1:30."),
					prior("after", Date.parse("2026-11-01T07:30:00Z"), "2:30."),
					// The hour skipped in spring is shown by no clock, so none repeats.
					prior("spring", Date.parse("2026-03-08T07:30:00Z"), "3:30."),
				],
				"America/New_York",
			),
		).toEqual([
			"[message_at=11-01 01:30-04:00] user: First 1:30.",
			"[message_at=11-01 01:30-05:00] user: Second 1:30.",
			"[message_at=11-01 02:30] user: 2:30.",
			"[message_at=03-08 03:30] user: 3:30.",
		]);
	});

	it("numbers a message a caller names by its stamp, from the second of one stamp on", () => {
		const [segment] = renderContextObject({
			id: "turn",
			metadata: { displayTimeZone: "America/New_York" },
			events: [prior("a", Date.parse("2026-11-20T21:18:19.338Z"), "Hi.")],
		}).promptSegments;
		const numbered = (displayOrdinal: number | string | null) =>
			segmentBlock({
				...segment,
				metadata: { ...segment.metadata, displayOrdinal },
			});
		expect(segmentBlock(segment)).toBe("[message_at=11-20 16:18] user: Hi.");
		expect(numbered(2)).toBe("[message_at=11-20 16:18 #2] user: Hi.");
		expect(numbered(14)).toBe("[message_at=11-20 16:18 #14] user: Hi.");
		// The first message of a stamp is the stamp alone.
		for (const none of [1, 0, -2, 2.5, "2", null])
			expect(numbered(none)).toBe("[message_at=11-20 16:18] user: Hi.");
		// The number follows whatever else the stamp needed to name its minute.
		const [repeated] = renderContextObject({
			id: "turn",
			metadata: { displayTimeZone: "America/New_York" },
			events: [prior("a", Date.parse("2026-11-01T05:30:00Z"), "First 1:30.")],
		}).promptSegments;
		expect(
			segmentBlock({
				...repeated,
				metadata: { ...repeated.metadata, displayOrdinal: 2 },
			}),
		).toBe("[message_at=11-01 01:30-04:00 #2] user: First 1:30.");
	});
});
