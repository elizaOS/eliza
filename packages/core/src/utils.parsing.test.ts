/**
 * Foundational parsing/identity utilities used throughout the runtime.
 * stringToUuid must be deterministic (same input → same id, so an external id
 * always maps to the same entity) and idempotent on an already-valid UUID;
 * parseJSONObjectFromText must recover an object from chatty model text or
 * return null; and the boolean/truncation helpers must degrade safely.
 * Pure deterministic unit test — no model or database.
 */
import { describe, expect, it } from "vitest";
import {
	parseBooleanFromText,
	parseJSONObjectFromText,
	stringToUuid,
	truncateToCompleteSentence,
	validateUuid,
} from "./utils.ts";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("stringToUuid", () => {
	it("is deterministic and well-formed", () => {
		const a = stringToUuid("discord:user:123");
		const b = stringToUuid("discord:user:123");
		expect(a).toBe(b);
		expect(a).toMatch(UUID_RE);
		expect(stringToUuid("discord:user:124")).not.toBe(a);
	});

	it("returns an already-valid UUID unchanged (idempotent) and accepts numbers", () => {
		const u = stringToUuid("seed");
		expect(stringToUuid(u)).toBe(u);
		expect(stringToUuid(42)).toMatch(UUID_RE);
	});
});

describe("validateUuid", () => {
	it("accepts valid UUIDs, rejects junk", () => {
		expect(validateUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(
			"123e4567-e89b-12d3-a456-426614174000",
		);
		expect(validateUuid("not-a-uuid")).toBeNull();
		expect(validateUuid(123)).toBeNull();
		expect(validateUuid(null)).toBeNull();
	});
});

describe("parseJSONObjectFromText", () => {
	it("recovers an object from surrounding prose, null on failure or arrays", () => {
		expect(parseJSONObjectFromText('{"a":1}')).toEqual({ a: 1 });
		expect(parseJSONObjectFromText('```json\n{"ok": true}\n```')).toEqual({
			ok: true,
		});
		expect(parseJSONObjectFromText("[1,2,3]")).toBeNull(); // arrays are not objects
		expect(parseJSONObjectFromText("no json")).toBeNull();
	});
});

describe("parseBooleanFromText", () => {
	it("maps affirmative/negative tokens, defaults false", () => {
		for (const v of ["yes", "Y", "true", "1", "on", "ENABLE"]) {
			expect(parseBooleanFromText(v)).toBe(true);
		}
		for (const v of ["no", "false", "0", "off", "maybe", ""]) {
			expect(parseBooleanFromText(v)).toBe(false);
		}
		expect(parseBooleanFromText(true)).toBe(true);
		expect(parseBooleanFromText(null)).toBe(false);
	});
});

describe("truncateToCompleteSentence", () => {
	it("returns text unchanged when within the limit", () => {
		expect(truncateToCompleteSentence("Short.", 100)).toBe("Short.");
	});

	it("truncates at the last sentence period that fits in the limit", () => {
		const out = truncateToCompleteSentence(
			"One. Two. Three is much longer.",
			10,
		);
		expect(out).toBe("One. Two.");
	});

	it("falls back to a word boundary with ellipsis when no period fits", () => {
		const out = truncateToCompleteSentence("alpha beta gamma delta", 12);
		expect(out.endsWith("...")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(15);
	});
});
