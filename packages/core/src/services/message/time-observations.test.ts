/** Exercises current-time grounding and exclusions with deterministic provider observations. */
import { describe, expect, it } from "vitest";
import {
	groundedCurrentTimeReply,
	requestAsksCurrentTime,
	statedTimeIsUngrounded,
} from "./time-observations";

// Friday, September 11, 2026 11:18:30 EDT == 15:18:30Z
const providers = {
	CURRENT_TIME: {
		text: "",
		values: {},
		data: {
			iso: "2026-09-11T15:18:30.625Z",
			date: "2026-09-11",
			time: "11:18:30",
			dayOfWeek: "Friday",
			humanReadable: "Friday, September 11, 2026 at 11:18:30 AM EDT",
			timeZone: "America/New_York",
		},
	},
} as never;

describe("statedTimeIsUngrounded", () => {
	it("recognizes current-time questions", () => {
		for (const q of [
			"what time is it right now for me?",
			"What day is it?",
			"whats the date today",
			"what's the current time",
			"what's today's date?",
		])
			expect(requestAsksCurrentTime(q)).toBe(true);
		expect(
			requestAsksCurrentTime("move my dentist appointment to friday at 4pm"),
		).toBe(false);
	});

	it("rejects an invented date and clock against the provider block (live 2026-09-11)", () => {
		expect(
			statedTimeIsUngrounded({
				reply:
					"Sunday, November 22, 2026 at 5:01:28 PM EST. (in your local time)",
				request: "what time is it right now for me?",
				providers,
			}),
		).toBe(true);
	});

	it("accepts the provider's own rendering and small clock drift", () => {
		expect(
			statedTimeIsUngrounded({
				reply: "It's Friday, September 11, 2026 at 11:18 AM EDT.",
				request: "what time is it right now for me?",
				providers,
			}),
		).toBe(false);
		expect(
			statedTimeIsUngrounded({
				reply: "It's about 11:25 AM for you.",
				request: "what time is it?",
				providers,
			}),
		).toBe(false);
	});

	it("rejects a wrong weekday or a clock off by hours", () => {
		expect(
			statedTimeIsUngrounded({
				reply: "It's Thursday.",
				request: "what day is it?",
				providers,
			}),
		).toBe(true);
		expect(
			statedTimeIsUngrounded({
				reply: "It's 2:16 PM EST for you.",
				request: "what time is it?",
				providers,
			}),
		).toBe(true);
	});

	it("never judges replies to other requests or turns without the provider", () => {
		expect(
			statedTimeIsUngrounded({
				reply:
					"Moved your vet appointment to Friday, September 11 at 4:00 PM EDT.",
				request: "move my vet appointment to friday at 4pm",
				providers,
			}),
		).toBe(false);
		expect(
			statedTimeIsUngrounded({
				reply: "It's Thursday.",
				request: "what day is it?",
				providers: {} as never,
			}),
		).toBe(false);
	});

	it("renders the grounded answer from the provider", () => {
		expect(groundedCurrentTimeReply(providers)).toBe(
			"It's Friday, September 11, 2026 at 11:18:30 AM EDT.",
		);
	});
});

it.each([
	["What date did Apollo 11 land?", "Sunday, July 20, 1969."],
	["What day was September 10?", "Thursday."],
	[
		"What day is it, and when is my appointment?",
		"Today is Friday. Your appointment is Thursday.",
	],
	["What day is it?", "It is Friday; yesterday was Thursday."],
	["What day is it?", 'The quoted note says "Thursday"; today is Friday.'],
	["What time is it in Tokyo?", "It is 12:18 AM."],
])("does not reinterpret other temporal claims: %s", (request, reply) => {
	expect(statedTimeIsUngrounded({ request, reply, providers })).toBe(false);
});
