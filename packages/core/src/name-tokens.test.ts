/**
 * Deterministic tests for the canonical `{{name}}` / `{{nameN}}` token helpers
 * (`name-tokens.ts`) and the `getRecentMessagesData` state accessor. Pure
 * string/object functions — no model or database in the loop.
 */

import { describe, expect, it } from "vitest";
import { replaceIndexedNameTokens, replaceNameTokens } from "./name-tokens";
import { getRecentMessagesData } from "./recent-messages-state";
import type { Memory, State } from "./types";

/**
 * Canonical `@elizaos/core` isomorphic helpers that `@elizaos/shared` (and, via
 * shared, `@elizaos/ui`) re-export. These cases pin the behavior that the two
 * former hand-inlined copies previously handled differently — whitespace inside
 * the token braces and `$`-sequences in user-entered names.
 */
describe("replaceNameTokens (canonical core impl)", () => {
	it("replaces both token spellings", () => {
		expect(replaceNameTokens("Hi {{name}}, aka {{agentName}}.", "Momo")).toBe(
			"Hi Momo, aka Momo.",
		);
	});

	it("tolerates whitespace inside the braces", () => {
		// The pre-consolidation core copy (system-prompt.ts) allowed whitespace;
		// the shared copy did not. The reconciled impl accepts both.
		expect(replaceNameTokens("Hi {{ name }}!", "Momo")).toBe("Hi Momo!");
		expect(replaceNameTokens("yo {{  agentName  }}", "Momo")).toBe("yo Momo");
	});

	it("inserts names containing $-sequences literally", () => {
		expect(replaceNameTokens("hello {{name}}", "Cash$$")).toBe("hello Cash$$");
		expect(replaceNameTokens("hello {{name}}", "M$&M")).toBe("hello M$&M");
		expect(replaceNameTokens("yo {{agentName}}", "A$AP")).toBe("yo A$AP");
	});

	it("returns falsey input unchanged", () => {
		expect(replaceNameTokens("", "Momo")).toBe("");
	});

	it("leaves indexed tokens for replaceIndexedNameTokens", () => {
		// `{{name}}` must not consume `{{name1}}`; the two helpers own disjoint
		// token shapes and compose in either order.
		expect(replaceNameTokens("{{name}} vs {{name1}}", "Momo")).toBe(
			"Momo vs {{name1}}",
		);
	});
});

describe("replaceIndexedNameTokens (canonical core impl)", () => {
	it("resolves {{nameN}} / {{userN}} against the positional array", () => {
		expect(
			replaceIndexedNameTokens("{{name1}} met {{user2}}", ["Ada", "Bo"]),
		).toBe("Ada met Bo");
	});

	it("tolerates whitespace inside the braces", () => {
		expect(replaceIndexedNameTokens("hi {{ name1 }}", ["Ada"])).toBe("hi Ada");
	});

	it("leaves out-of-range slots untouched (never blanks a token)", () => {
		// The former `.replaceAll` mirrors iterated the name pool, so an unfilled
		// slot was simply skipped and left literal; preserve that.
		expect(replaceIndexedNameTokens("{{name3}}", ["Ada"])).toBe("{{name3}}");
		expect(replaceIndexedNameTokens("{{name1}}", [])).toBe("{{name1}}");
	});

	it("inserts names containing $-sequences literally", () => {
		// The `.replaceAll(placeholder, value)` mirrors corrupted these: `$$` ->
		// `$`, `$&` -> matched token, `$1` -> capture group. The replacer-function
		// impl inserts them verbatim.
		expect(replaceIndexedNameTokens("{{name1}}", ["Cash$$"])).toBe("Cash$$");
		expect(replaceIndexedNameTokens("{{name1}}", ["M$&M"])).toBe("M$&M");
		expect(replaceIndexedNameTokens("{{user1}}", ["A$1P"])).toBe("A$1P");
		expect(replaceIndexedNameTokens("{{name1}}", ["net$"])).toBe("net$");
	});

	it("returns falsey input unchanged", () => {
		expect(replaceIndexedNameTokens("", ["Ada"])).toBe("");
	});
});

describe("getRecentMessagesData (canonical core impl)", () => {
	const memory = { id: "m1" } as unknown as Memory;

	it("reads the canonical provider path", () => {
		const state = {
			data: {
				providers: {
					RECENT_MESSAGES: { data: { recentMessages: [memory] } },
				},
			},
		} as unknown as State;
		expect(getRecentMessagesData(state)).toEqual([memory]);
	});

	it("returns [] when the path is absent, undefined, or not an array", () => {
		expect(getRecentMessagesData(undefined)).toEqual([]);
		expect(getRecentMessagesData({} as State)).toEqual([]);
		const bad = {
			data: { providers: { RECENT_MESSAGES: { data: { recentMessages: 7 } } } },
		} as unknown as State;
		expect(getRecentMessagesData(bad)).toEqual([]);
	});
});
