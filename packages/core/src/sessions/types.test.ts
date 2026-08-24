/**
 * Session entry contracts (`sessions/types.ts`): entry construction and merge
 * must preserve identity, keep `updatedAt` monotonic against wall-clock time,
 * let patches override stored fields without mutating the stored entry, and
 * validity must gate on a non-empty string sessionId plus numeric updatedAt.
 */
import { describe, expect, it } from "vitest";
import {
	createSessionEntry,
	DEFAULT_IDLE_MINUTES,
	DEFAULT_RESET_TRIGGER,
	DEFAULT_RESET_TRIGGERS,
	isValidSessionEntry,
	mergeSessionEntry,
} from "./types.ts";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeFullEntry() {
	return {
		sessionId: "entry-1",
		updatedAt: 1000,
		label: "old label",
		channel: "discord",
		chatType: "group" as const,
		totalTokens: 42,
	};
}

describe("mergeSessionEntry", () => {
	it("creates an entry from nothing with generated identity", () => {
		const before = Date.now();
		const entry = mergeSessionEntry(undefined, {});

		expect(entry.sessionId).toMatch(UUID_PATTERN);
		expect(entry.updatedAt).toBeGreaterThanOrEqual(before);
		expect(entry.updatedAt).toBeLessThanOrEqual(Date.now());
	});

	it("keeps patch fields when creating from nothing", () => {
		const entry = mergeSessionEntry(undefined, {
			sessionId: "fixed-id",
			label: "new",
			channel: "telegram",
		});

		expect(entry.sessionId).toBe("fixed-id");
		expect(entry.label).toBe("new");
		expect(entry.channel).toBe("telegram");
		expect(entry.updatedAt).toBeLessThanOrEqual(Date.now());
	});

	it("honors a future patch updatedAt verbatim but floors it at now otherwise", () => {
		const before = Date.now();
		const future = before + 60_000;

		expect(mergeSessionEntry(undefined, { updatedAt: future }).updatedAt).toBe(
			future,
		);
		const merged = mergeSessionEntry(undefined, { updatedAt: 5 });
		expect(merged.updatedAt).toBeGreaterThanOrEqual(before);
	});

	it("merges onto an existing entry without mutating it", () => {
		const existing = makeFullEntry();
		const merged = mergeSessionEntry(existing, { label: "new label" });

		expect(merged.label).toBe("new label");
		expect(existing.label).toBe("old label");
		for (const key of [
			"sessionId",
			"channel",
			"chatType",
			"totalTokens",
		] as const) {
			expect(merged[key]).toBe(existing[key]);
		}
	});

	it("lets the patch replace the sessionId", () => {
		const merged = mergeSessionEntry(makeFullEntry(), { sessionId: "moved" });
		expect(merged.sessionId).toBe("moved");
	});

	it("never moves updatedAt backward even when patch supplies a past value", () => {
		const before = Date.now();
		const existing = makeFullEntry(); // updatedAt 1000, far in the past

		const patchedPast = mergeSessionEntry(existing, { updatedAt: 1 });
		expect(patchedPast.updatedAt).toBeGreaterThanOrEqual(before);

		const future = before + 60_000;
		const existingFuture = mergeSessionEntry(existing, {});
		existingFuture.updatedAt = future;
		const kept = mergeSessionEntry(existingFuture, { updatedAt: 1 });
		expect(kept.updatedAt).toBe(future);
	});
});

describe("createSessionEntry", () => {
	it("fills defaults for identity and timestamp", () => {
		const before = Date.now();
		const entry = createSessionEntry();

		expect(entry.sessionId).toMatch(UUID_PATTERN);
		expect(entry.updatedAt).toBeGreaterThanOrEqual(before);
		expect(entry.updatedAt).toBeLessThanOrEqual(Date.now());
	});

	it("applies overrides over the defaults", () => {
		const fixed = createSessionEntry({ sessionId: "cli-session" });
		expect(fixed.sessionId).toBe("cli-session");
		expect(fixed.updatedAt).toBeLessThanOrEqual(Date.now());

		const stamped = createSessionEntry({
			sessionId: "s",
			updatedAt: 12345,
			label: "backfilled",
		});
		expect(stamped).toEqual({
			sessionId: "s",
			updatedAt: 12345,
			label: "backfilled",
		});
	});
});

describe("isValidSessionEntry", () => {
	it("rejects non-objects and nullish values", () => {
		expect(isValidSessionEntry(null)).toBe(false);
		expect(isValidSessionEntry(undefined)).toBe(false);
		expect(isValidSessionEntry("entry-1")).toBe(false);
		expect(isValidSessionEntry(42)).toBe(false);
		expect(isValidSessionEntry([])).toBe(false);
	});

	it("requires a non-empty string sessionId and numeric updatedAt", () => {
		expect(isValidSessionEntry({})).toBe(false);
		expect(isValidSessionEntry({ sessionId: "", updatedAt: 1 })).toBe(false);
		expect(isValidSessionEntry({ sessionId: "abc" })).toBe(false);
		expect(isValidSessionEntry({ sessionId: "abc", updatedAt: "soon" })).toBe(
			false,
		);
	});

	it("accepts a minimal valid entry regardless of extra fields", () => {
		expect(isValidSessionEntry({ sessionId: "abc", updatedAt: 123 })).toBe(
			true,
		);
		expect(
			isValidSessionEntry({
				sessionId: "abc",
				updatedAt: Number.NaN,
				label: "extra fields do not matter",
			}),
		).toBe(true);
	});

	it("accepts entries produced by createSessionEntry and mergeSessionEntry", () => {
		expect(isValidSessionEntry(createSessionEntry())).toBe(true);
		expect(isValidSessionEntry(mergeSessionEntry(undefined, {}))).toBe(true);
		expect(
			isValidSessionEntry(mergeSessionEntry(createSessionEntry(), {})),
		).toBe(true);
	});
});

describe("reset + idle defaults", () => {
	it("exposes the documented default triggers and idle window", () => {
		expect(DEFAULT_RESET_TRIGGER).toBe("/new");
		expect(DEFAULT_RESET_TRIGGERS).toEqual(["/new", "/reset"]);
		expect(DEFAULT_RESET_TRIGGERS).toContain(DEFAULT_RESET_TRIGGER);
		expect(DEFAULT_IDLE_MINUTES).toBe(60);
	});
});
