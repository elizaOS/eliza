/**
 * The shared agent-name matcher: normalization, distinctive-token expansion
 * for multi-word names (>= 4-char tokens), and boundary-anchored text
 * matching. Pins the live 2026-08-22 case where a single token of a
 * multi-word agent name must count as addressing the agent.
 */
import { describe, expect, it } from "vitest";
import {
	distinctiveNameTokens,
	escapeRegex,
	normalizeName,
	textContainsAgentName,
} from "./agent-name-match.ts";

describe("normalizeName", () => {
	it("trims, lowercases, and strips one leading @", () => {
		expect(normalizeName("  @Eliza ")).toBe("eliza");
		expect(normalizeName("Remilio Nubilio")).toBe("remilio nubilio");
	});
});

describe("escapeRegex", () => {
	it("escapes regex metacharacters so names embed literally", () => {
		const escaped = escapeRegex("a.b*c(d)");
		expect(new RegExp(`^${escaped}$`).test("a.b*c(d)")).toBe(true);
		expect(new RegExp(`^${escaped}$`).test("axbbc(d)")).toBe(false);
	});
});

describe("distinctiveNameTokens", () => {
	it("returns the full name plus each token of at least 4 characters", () => {
		expect(distinctiveNameTokens("remilio nubilio")).toEqual([
			"remilio nubilio",
			"remilio",
			"nubilio",
		]);
	});

	it("excludes short tokens that would match ordinary prose", () => {
		expect(distinctiveNameTokens("Al Bot")).toEqual(["Al Bot"]);
	});

	it("returns nothing for blank input", () => {
		expect(distinctiveNameTokens("   ")).toEqual([]);
	});
});

describe("textContainsAgentName", () => {
	it("matches the full name on word boundaries, case-insensitively", () => {
		expect(textContainsAgentName("hey Eliza, you up?", ["eliza"])).toBe(true);
		expect(textContainsAgentName("elizabeth was here", ["eliza"])).toBe(false);
	});

	it("a single distinctive TOKEN of a multi-word name counts (live 2026-08-22)", () => {
		expect(
			textContainsAgentName("nubilio whats the setting we use", [
				"remilio nubilio",
			]),
		).toBe(true);
	});

	it("ignores empty text and nullish names", () => {
		expect(textContainsAgentName(undefined, ["eliza"])).toBe(false);
		expect(textContainsAgentName("hello", [null, undefined, "  "])).toBe(false);
	});
});
