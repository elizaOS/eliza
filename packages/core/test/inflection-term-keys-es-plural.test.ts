import { expect, test } from "vitest";
import { inflectionTermKeys } from "../src/utils/inflection-term-keys";

test("term matching offers the singular of an -es plural", () => {
	// Sibilant and "-o" stems take "-es": without the extra key, the plural
	// only indexes the "…e" form ("boxe", "watche") and the singular misses.
	for (const [base, plural] of [
		["box", "boxes"],
		["watch", "watches"],
		["dish", "dishes"],
		["bus", "buses"],
		["hero", "heroes"],
	]) {
		const pluralKeys = new Set(inflectionTermKeys(plural));
		expect(inflectionTermKeys(base).some((key) => pluralKeys.has(key))).toBe(
			true,
		);
	}
});

test("term matching keeps the plain -s plural on an e stem", () => {
	// "houses"/"caches" are "-s" plurals of an "e"-ending stem, so the "…e"
	// key the single-"s" strip produces must stay.
	for (const [base, plural] of [
		["house", "houses"],
		["cache", "caches"],
	]) {
		const pluralKeys = new Set(inflectionTermKeys(plural));
		expect(inflectionTermKeys(base).some((key) => pluralKeys.has(key))).toBe(
			true,
		);
	}
});
