import { describe, expect, it } from "vitest";
import { replaceNameTokens } from "./name-tokens";
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
