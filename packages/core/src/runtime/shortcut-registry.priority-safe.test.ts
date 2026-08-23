/**
 * Priority handling in `matchShortcut`. `ShortcutDefinition.priority` is an
 * optional number on a plugin-supplied definition, and the three decisions that
 * consume it all guard absence with `?? 0` — which replaces `undefined` but not
 * a non-finite value that a plugin computed (a bad division, a parsed config
 * field, an unchecked `Number()`).
 *
 * Unlike `confidence`, priority is never floored out: the confidence filter
 * (`>= SHORTCUT_CONFIDENCE_FLOOR`) drops a NaN confidence before the sort, but
 * nothing drops a NaN priority. It reaches the explicit-tier sort, the
 * natural-tier tie-break, and — most consequentially — the ambiguity refusal,
 * where `NaN === NaN` is false so two genuinely ambiguous matches stop being
 * recognized as equal-priority and one is executed instead of deferring.
 *
 * Deterministic: plain definitions, no runtime, no IO.
 */
import { describe, expect, it } from "vitest";
import type { ShortcutDefinition } from "../types/shortcut.ts";
import { matchShortcut } from "./shortcut-registry.ts";

function explicit(
	id: string,
	alias: string,
	priority?: number,
): ShortcutDefinition {
	return {
		id,
		kind: "explicit",
		aliases: [alias],
		target: { kind: "navigate", path: `/${id}` },
		...(priority === undefined ? {} : { priority }),
	} as ShortcutDefinition;
}

function natural(
	id: string,
	pattern: string,
	confidence: number,
	priority?: number,
): ShortcutDefinition {
	return {
		id,
		kind: "natural",
		patterns: [{ template: pattern, confidence }],
		target: { kind: "navigate", path: `/${id}` },
		...(priority === undefined ? {} : { priority }),
	} as unknown as ShortcutDefinition;
}

describe("matchShortcut priority handling", () => {
	it("picks the highest finite priority among explicit aliases", () => {
		const match = matchShortcut(
			[explicit("low", "/go", 1), explicit("high", "/go", 5)],
			"/go",
		);
		expect(match?.shortcut.id).toBe("high");
	});

	it("does not let a NaN priority win the explicit tier over a real priority", () => {
		const match = matchShortcut(
			[explicit("bad", "/go", Number.NaN), explicit("high", "/go", 5)],
			"/go",
		);
		expect(match?.shortcut.id).toBe("high");
	});

	it("treats a NaN priority as the absent-priority default, not as a winner", () => {
		// `?? 0` means an absent priority is 0; a NaN priority must rank the same
		// rather than returning NaN from the comparator.
		const match = matchShortcut(
			[explicit("bad", "/go", Number.NaN), explicit("none", "/go")],
			"/go",
		);
		expect(match).not.toBeNull();
		expect(["bad", "none"]).toContain(match?.shortcut.id);
	});

	it("still refuses two ambiguous natural matches at equal absent priority", () => {
		const match = matchShortcut(
			[natural("a", "open {x}", 0.9), natural("b", "open {x}", 0.9)],
			"open inbox",
			{ allowNatural: true },
		);
		expect(match).toBeNull();
	});

	it("refuses ambiguity when both sides carry a non-finite priority", () => {
		// NaN === NaN is false, so the equal-priority arm of the ambiguity guard
		// silently stops firing and one of two tied shortcuts is executed.
		const match = matchShortcut(
			[
				natural("a", "open {x}", 0.9, Number.NaN),
				natural("b", "open {x}", 0.9, Number.NaN),
			],
			"open inbox",
			{ allowNatural: true },
		);
		expect(match).toBeNull();
	});

	it("still resolves a genuine priority difference in the natural tier", () => {
		const match = matchShortcut(
			[natural("a", "open {x}", 0.9, 1), natural("b", "open {x}", 0.9, 9)],
			"open inbox",
			{ allowNatural: true },
		);
		expect(match?.shortcut.id).toBe("b");
	});
});
