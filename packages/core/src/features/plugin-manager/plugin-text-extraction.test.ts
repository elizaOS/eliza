/**
 * Coverage for the free-form-text extractors in `actions/plugin.ts`
 * (`extractNameFromText`, `extractQueryFromText`). Both trim trailing
 * punctuation off a captured token; that strip used a `/[?.!,]+$/`-style
 * anchored quantifier that was O(n²) on the message text (attacker-supplied),
 * now a linear scan. These tests pin the extraction results and prove the
 * pathological inputs complete in linear time. Pure functions, no runtime.
 */
import { describe, expect, it } from "vitest";
import { extractNameFromText, extractQueryFromText } from "./actions/plugin.ts";

describe("extractNameFromText", () => {
	it("returns a scoped identifier verbatim", () => {
		expect(extractNameFromText("please install @scope/plugin-foo")).toBe(
			"@scope/plugin-foo",
		);
	});

	it("returns a bare plugin- identifier", () => {
		expect(extractNameFromText("please install plugin-bar now")).toBe(
			"plugin-bar",
		);
	});

	it("prefixes a bare verb-object token", () => {
		expect(extractNameFromText("install foo")).toBe("plugin-foo");
	});

	it("is linear on a long dotted token (ReDoS input)", () => {
		const evil = `install a${".".repeat(200_000)}b`;
		const start = performance.now();
		const out = extractNameFromText(evil);
		const elapsed = performance.now() - start;
		expect(out?.startsWith("plugin-a")).toBe(true);
		expect(elapsed).toBeLessThan(1000);
	});
});

describe("extractQueryFromText", () => {
	it("extracts and cleans a search query", () => {
		expect(extractQueryFromText("find plugins for image generation!")).toBe(
			"image generation",
		);
	});

	it("is linear on a long punctuation run (ReDoS input)", () => {
		const evil = `search for plugins that ${"!".repeat(200_000)}x`;
		const start = performance.now();
		const out = extractQueryFromText(evil);
		const elapsed = performance.now() - start;
		expect(out?.endsWith("x")).toBe(true);
		expect(elapsed).toBeLessThan(1000);
	});
});
