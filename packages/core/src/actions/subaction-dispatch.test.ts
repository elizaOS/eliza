/**
 * Unit tests for umbrella action subaction normalization, reading, and dispatch.
 */

import { describe, expect, it, vi } from "vitest";
import {
	CANONICAL_SUBACTION_KEY,
	DEFAULT_SUBACTION_KEYS,
	dispatchSubaction,
	normalizeSubaction,
	readSubaction,
} from "./subaction-dispatch.js";

describe("subaction-dispatch", () => {
	it("normalizes subaction names handling whitespace, dashes, and casing", () => {
		expect(normalizeSubaction(" CREATE ")).toBe("create");
		expect(normalizeSubaction("spawn-agent")).toBe("spawn_agent");
		expect(normalizeSubaction("list_all_tasks")).toBe("list_all_tasks");
		expect(normalizeSubaction("")).toBeUndefined();
		expect(normalizeSubaction(null)).toBeUndefined();
		expect(normalizeSubaction(123)).toBeUndefined();
	});

	it("reads subaction from canonical and legacy parameter keys", () => {
		const allowed = ["create", "list", "delete"] as const;

		// Canonical key 'action'
		expect(readSubaction({ action: "create" }, { allowed })).toBe("create");

		// Legacy key 'subaction'
		expect(readSubaction({ subaction: "list" }, { allowed })).toBe("list");

		// Legacy key 'op'
		expect(readSubaction({ op: "delete" }, { allowed })).toBe("delete");

		// Falls back to defaultValue when missing
		expect(readSubaction({}, { allowed, defaultValue: "list" })).toBe("list");
	});

	it("applies alias mapping during subaction resolution", () => {
		const allowed = ["create", "list"] as const;
		const aliases = { add: "create" as const, get: "list" as const };

		expect(readSubaction({ action: "add" }, { allowed, aliases })).toBe(
			"create",
		);
		expect(readSubaction({ action: "get" }, { allowed, aliases })).toBe("list");
	});

	it("returns undefined for disallowed or unknown subactions", () => {
		const allowed = ["create", "list"] as const;

		expect(readSubaction({ action: "destroy" }, { allowed })).toBeUndefined();
	});

	it("dispatches to matching handler in handler map", async () => {
		const createHandler = vi.fn(async (ctx: { taskId: string }) => ({
			success: true,
			text: `Created ${ctx.taskId}`,
		}));
		const listHandler = vi.fn(async () => ({
			success: true,
			text: "Listed",
		}));

		const handlers = {
			create: createHandler,
			list: listHandler,
		};

		const result = await dispatchSubaction("create", handlers, {
			taskId: "task-1",
		});
		expect(result).toEqual({ success: true, text: "Created task-1" });
		expect(createHandler).toHaveBeenCalledWith({ taskId: "task-1" });
		expect(listHandler).not.toHaveBeenCalled();
	});

	it("returns UNKNOWN_SUBACTION error result for missing or unknown subaction", async () => {
		const handlers = {
			create: async () => ({ success: true }),
		};

		// Missing subaction
		const missingResult = await dispatchSubaction(
			undefined,
			handlers as unknown as { create: () => Promise<{ success: boolean }> },
			undefined,
		);
		expect(missingResult.success).toBe(false);
		expect(missingResult.error).toBe("UNKNOWN_SUBACTION");
		expect(missingResult.text).toBe("Missing subaction");

		// Unknown subaction
		const unknownResult = await dispatchSubaction(
			"delete" as unknown as "create",
			handlers,
			undefined,
		);
		expect(unknownResult.success).toBe(false);
		expect(unknownResult.error).toBe("UNKNOWN_SUBACTION");
		expect(unknownResult.text).toBe("Unknown subaction: delete");
	});

	it("exports canonical and default subaction keys", () => {
		expect(CANONICAL_SUBACTION_KEY).toBe("action");
		expect(DEFAULT_SUBACTION_KEYS).toContain("action");
		expect(DEFAULT_SUBACTION_KEYS).toContain("subaction");
		expect(DEFAULT_SUBACTION_KEYS).toContain("op");
	});
});
