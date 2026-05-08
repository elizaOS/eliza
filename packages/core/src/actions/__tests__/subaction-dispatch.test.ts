import { describe, expect, it } from "vitest";
import {
	dispatchSubaction,
	normalizeSubaction,
	readSubaction,
} from "../subaction-dispatch";

describe("subaction-dispatch", () => {
	it("normalizes planner-facing op names", () => {
		expect(normalizeSubaction("Search YouTube")).toBe("search_youtube");
		expect(normalizeSubaction("play-query")).toBe("play_query");
		expect(normalizeSubaction("  ")).toBeUndefined();
		expect(normalizeSubaction(null)).toBeUndefined();
	});

	it("reads op/subaction/action keys with aliases", () => {
		const allowed = ["download", "play_query", "search_youtube"] as const;

		expect(
			readSubaction(
				{ action: "play-query" },
				{
					allowed,
					aliases: { play: "play_query", youtube: "search_youtube" },
				},
			),
		).toBe("play_query");

		expect(
			readSubaction(
				{ subaction: "youtube" },
				{
					allowed,
					aliases: { youtube: "search_youtube" },
				},
			),
		).toBe("search_youtube");

		expect(readSubaction({}, { allowed, defaultValue: "download" })).toBe(
			"download",
		);
		expect(readSubaction({ op: "unknown" }, { allowed })).toBeUndefined();
	});

	it("dispatches to the selected handler", async () => {
		const result = await dispatchSubaction(
			"download",
			{
				download: async ({ id }: { id: string }) => ({
					success: true,
					data: { id },
				}),
			},
			{ id: "track-1" },
		);

		expect(result).toEqual({ success: true, data: { id: "track-1" } });
	});

	it("returns a structured error for missing handlers", async () => {
		const result = await dispatchSubaction(
			undefined,
			{ download: async () => ({ success: true }) },
			undefined,
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("UNKNOWN_SUBACTION");
	});
});
