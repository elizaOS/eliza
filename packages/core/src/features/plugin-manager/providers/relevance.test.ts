/**
 * Covers the relevance-gating helpers for the plugin-manager providers. These
 * decide whether a dynamic provider injects context into a turn, so both
 * directions matter: firing on unrelated chat is prompt noise, and failing to
 * fire hides plugin state the user asked about.
 *
 * Two properties are pinned deliberately. `buildKeywordRegex` sorts longest
 * keyword first — with alternation the first match wins, so an unsorted bank
 * would let "plugin" shadow "plugin manager" — and it escapes regex
 * metacharacters, so a plugin name containing `.` cannot become a wildcard that
 * matches unrelated text. It is also non-global, so repeated `.test()` on the
 * same input stays stable.
 *
 * Pure functions — no runtime, no state, no IO.
 */
import { describe, expect, it } from "vitest";

import {
	buildKeywordRegex,
	buildProviderKeywords,
	COMMON_CONNECTOR_KEYWORDS,
	keywordsFromPluginNames,
	PLUGIN_MANAGER_BASE_KEYWORDS,
} from "./relevance.ts";

describe("buildProviderKeywords", () => {
	it("merges groups, lowercases, trims, and de-duplicates", () => {
		expect(
			buildProviderKeywords(["  Plugin  ", "plugin"], ["EXTENSION"]),
		).toEqual(["plugin", "extension"]);
	});

	it("skips undefined groups and blank entries", () => {
		expect(
			buildProviderKeywords(undefined, ["a", "", "   "], undefined),
		).toEqual(["a"]);
	});

	it("returns an empty list when given nothing", () => {
		expect(buildProviderKeywords()).toEqual([]);
	});
});

describe("keywordsFromPluginNames", () => {
	it("derives the scoped name, unscoped name, unprefixed name, and tokens", () => {
		const keywords = keywordsFromPluginNames(["@elizaos/plugin-discord"]);
		expect(keywords).toContain("@elizaos/plugin-discord");
		expect(keywords).toContain("plugin-discord");
		expect(keywords).toContain("discord");
	});

	it("strips an app- prefix as well as plugin-", () => {
		expect(keywordsFromPluginNames(["app-browser"])).toContain("browser");
	});

	it("drops generic split tokens that would match everything", () => {
		// The ignored-token filter applies to the split tokens: "app" is dropped
		// while the meaningful "storage" token survives.
		const keywords = keywordsFromPluginNames(["@elizaos/plugin-app-storage"]);
		expect(keywords).toContain("storage");
		expect(keywords).not.toContain("app");
		expect(keywords).not.toContain("plugin");
	});

	it("does not turn the npm scope into a keyword", () => {
		expect(keywordsFromPluginNames(["@elizaos/plugin-discord"])).not.toContain(
			"elizaos",
		);
	});

	it("drops single-character tokens", () => {
		expect(keywordsFromPluginNames(["plugin-a-storage"])).not.toContain("a");
	});

	it("ignores blank names and de-duplicates across inputs", () => {
		const keywords = keywordsFromPluginNames([
			"  ",
			"@elizaos/plugin-discord",
			"@elizaos/plugin-discord",
		]);
		expect(new Set(keywords).size).toBe(keywords.length);
	});

	it("lowercases names before deriving keywords", () => {
		expect(keywordsFromPluginNames(["@ElizaOS/Plugin-Discord"])).toContain(
			"discord",
		);
	});
});

describe("buildKeywordRegex", () => {
	it("matches a keyword on a word boundary, case-insensitively", () => {
		const regex = buildKeywordRegex(["discord"]);
		expect(regex.test("connect Discord please")).toBe(true);
		expect(regex.test("discordant opinions")).toBe(false);
	});

	it("never matches real text when the keyword list is empty", () => {
		// The empty bank compiles to the never-matching `/$^/` sentinel. Callers
		// guard on non-empty text before testing, so the only contract that
		// matters is that no actual content matches.
		const regex = buildKeywordRegex([]);
		for (const text of ["plugin", "discord", "anything at all", " "]) {
			expect(regex.test(text)).toBe(false);
		}
	});

	it("orders longer keywords first so a prefix cannot shadow a longer phrase", () => {
		// Alternation takes the first match, so "plugin" listed first would win.
		const match = buildKeywordRegex(["plugin", "plugin manager"]).exec(
			"open the plugin manager",
		);
		expect(match?.[1]).toBe("plugin manager");
	});

	it("escapes regex metacharacters so a name cannot become a wildcard", () => {
		const regex = buildKeywordRegex(["a.b"]);
		expect(regex.test("a.b")).toBe(true);
		expect(regex.test("axb")).toBe(false);
	});

	it("is not a global regex, so repeated tests are stable", () => {
		const regex = buildKeywordRegex(["discord"]);
		const text = "discord";
		expect([regex.test(text), regex.test(text), regex.test(text)]).toEqual([
			true,
			true,
			true,
		]);
	});

	it("ignores blank keywords rather than matching everything", () => {
		const regex = buildKeywordRegex(["", "   "]);
		expect(regex.test("anything at all")).toBe(false);
	});
});

describe("keyword banks", () => {
	it("are non-empty, lowercase, and free of duplicates", () => {
		for (const bank of [
			PLUGIN_MANAGER_BASE_KEYWORDS,
			COMMON_CONNECTOR_KEYWORDS,
		]) {
			expect(bank.length).toBeGreaterThan(0);
			expect([...bank]).toEqual(bank.map((k) => k.toLowerCase()));
			expect(new Set(bank).size).toBe(bank.length);
		}
	});

	it("compile into a regex that matches representative phrasing", () => {
		const regex = buildKeywordRegex([
			...PLUGIN_MANAGER_BASE_KEYWORDS,
			...COMMON_CONNECTOR_KEYWORDS,
		]);
		for (const text of [
			"can you install a plugin?",
			"is discord connected?",
			"show the plugin manager status",
		]) {
			expect(regex.test(text)).toBe(true);
		}
		expect(regex.test("what is the weather tomorrow")).toBe(false);
	});
});
