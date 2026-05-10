import { describe, expect, it } from "vitest";
import {
	CANONICAL_SUBACTION_KEY,
	DEFAULT_SUBACTION_KEYS,
	dispatchSubaction,
	normalizeSubaction,
	readSubaction,
} from "../subaction-dispatch";

describe("subaction-dispatch", () => {
	it("documents action as the canonical key with legacy aliases", () => {
		expect(CANONICAL_SUBACTION_KEY).toBe("action");
		expect(DEFAULT_SUBACTION_KEYS).toEqual([
			"action",
			"subaction",
			"op",
			"operation",
			"verb",
			"subAction",
			"__subaction",
		]);
	});

	it("prefers action over legacy aliases when multiple are present", () => {
		const allowed = ["list", "create"] as const;
		expect(
			readSubaction(
				{ action: "list", subaction: "create", op: "create" },
				{ allowed },
			),
		).toBe("list");
		expect(readSubaction({ subaction: "list" }, { allowed })).toBe("list");
		expect(readSubaction({ op: "list" }, { allowed })).toBe("list");
		expect(readSubaction({ action: "create" }, { allowed })).toBe("create");
		expect(readSubaction({ operation: "create" }, { allowed })).toBe("create");
		expect(readSubaction({ verb: "create" }, { allowed })).toBe("create");
	});

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
