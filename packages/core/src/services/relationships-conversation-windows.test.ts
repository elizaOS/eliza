/**
 * Verifies conversation-window counting across the timestamp shapes returned
 * by persisted relationship memories, including ISO strings and invalid input.
 */

import { describe, expect, it } from "vitest";
import type { UUID } from "../types/primitives";
import { countSharedConversationWindows } from "./relationships";

const LEFT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const RIGHT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const ROOM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;

describe("countSharedConversationWindows timestamp parsing", () => {
	it("counts an ISO-string conversation window and sorts it chronologically", () => {
		expect(
			countSharedConversationWindows(
				[
					{
						entityId: RIGHT,
						roomId: ROOM,
						createdAt: "2026-08-15T10:30:00.000Z",
					},
					{
						entityId: LEFT,
						roomId: ROOM,
						createdAt: "2026-08-15T10:00:00.000Z",
					},
				],
				LEFT,
				RIGHT,
			),
		).toBe(1);
	});

	it("continues to accept numeric strings", () => {
		expect(
			countSharedConversationWindows(
				[
					{ entityId: LEFT, roomId: ROOM, createdAt: "1000" },
					{ entityId: RIGHT, roomId: ROOM, createdAt: "2000" },
				],
				LEFT,
				RIGHT,
			),
		).toBe(1);
	});

	it("excludes malformed timestamp strings", () => {
		expect(
			countSharedConversationWindows(
				[
					{ entityId: LEFT, roomId: ROOM, createdAt: "not-a-date" },
					{
						entityId: RIGHT,
						roomId: ROOM,
						createdAt: "2026-08-15T10:30:00.000Z",
					},
				],
				LEFT,
				RIGHT,
			),
		).toBe(0);
	});
});
