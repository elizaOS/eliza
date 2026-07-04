/**
 * Exercises `matchTopicRooms` (channel-topics): cross-channel topic search that
 * ranks rooms by matching-topic count, matches whitespace tokens
 * case-insensitively, and honors the empty-query / limit / no-match edge cases.
 * Pure-function checks.
 */
import { describe, expect, it } from "vitest";
import { matchTopicRooms } from "./channel-topics.ts";

const ROOMS = {
	"room-a": ["billing refund", "stripe payout", "invoice"],
	"room-b": ["stripe webhook", "deploy"],
	"room-c": ["chat ux", "swipe gesture"],
};

describe("matchTopicRooms — cross-channel topic search (#8927)", () => {
	it("ranks rooms by number of matching topics, most first", () => {
		const hits = matchTopicRooms(ROOMS, "stripe");
		expect(hits.map((h) => h.roomId)).toEqual(["room-a", "room-b"]);
		expect(hits[0].matchedTopics).toEqual(["stripe payout"]);
	});

	it("matches any whitespace-delimited token, case-insensitively", () => {
		const hits = matchTopicRooms(ROOMS, "SWIPE deploy");
		expect(hits.map((h) => h.roomId).sort()).toEqual(["room-b", "room-c"]);
	});

	it("returns the full topic list alongside the matched subset", () => {
		const [hit] = matchTopicRooms(ROOMS, "refund");
		expect(hit.roomId).toBe("room-a");
		expect(hit.matchedTopics).toEqual(["billing refund"]);
		expect(hit.topics).toEqual(ROOMS["room-a"]);
	});

	it("returns [] for an empty query and respects the limit", () => {
		expect(matchTopicRooms(ROOMS, "   ")).toEqual([]);
		expect(matchTopicRooms(ROOMS, "stripe", 1)).toHaveLength(1);
	});

	it("returns [] when nothing matches", () => {
		expect(matchTopicRooms(ROOMS, "nonexistent")).toEqual([]);
	});
});
