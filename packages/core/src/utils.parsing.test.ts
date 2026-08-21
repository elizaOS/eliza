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
	parseToonKeyValue,
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

	it("returns null for scalars, which JSON5 parses as valid JSON", () => {
		expect(parseJSONObjectFromText("42")).toBeNull();
		expect(parseJSONObjectFromText("true")).toBeNull();
		expect(parseJSONObjectFromText("null")).toBeNull();
		// A model reply wrapped in quotes is a JSON string, not an object.
		expect(
			parseJSONObjectFromText('"Sure - I added milk to your shopping list."'),
		).toBeNull();
	});
});

describe("parseToonKeyValue", () => {
	it("parses a compact unlabeled whole-value code fence", () => {
		expect(parseToonKeyValue("```name: eliza```")).toEqual({ name: "eliza" });
	});

	it("parses indexed and scalar keys around adversarial delimiter whitespace", () => {
		const spacing = " ".repeat(100_000);
		expect(
			parseToonKeyValue(`name${spacing}:${spacing}eliza\nitems[2]: ready`),
		).toEqual({ name: "eliza", items: [undefined, undefined, "ready"] });
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
		expect(out.length).toBeLessThanOrEqual(12);
	});

	it("never exceeds tiny limits that cannot fit an ellipsis", () => {
		expect(truncateToCompleteSentence("abcdef", 0)).toBe("");
		expect(truncateToCompleteSentence("abcdef", 1)).toBe("a");
		expect(truncateToCompleteSentence("abcdef", 2)).toBe("ab");
		expect(truncateToCompleteSentence("abcdef", 3)).toBe("abc");
		expect(truncateToCompleteSentence("😀abc", 1)).toBe("");
	});

	it("keeps a tweet-sized truncation within the 280 character cap", () => {
		const text = "word ".repeat(60).trim();
		expect(text.length).toBeGreaterThan(280);
		const out = truncateToCompleteSentence(text, 280);
		expect(out.endsWith("...")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(280);
	});

	it("still ends at a period when one fits, without an ellipsis", () => {
		const out = truncateToCompleteSentence("One. Two. Three is longer.", 10);
		expect(out).toBe("One. Two.");
		expect(out.length).toBeLessThanOrEqual(10);
	});

	it("returns text unchanged when it already fits", () => {
		expect(truncateToCompleteSentence("short", 280)).toBe("short");
	});
});
