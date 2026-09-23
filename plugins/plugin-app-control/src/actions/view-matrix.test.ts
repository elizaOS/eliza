/**
 * Exercises deterministic compatibility routing for multilingual nouns, curated
 * phrases, and negative controls. Each input is asserted directly; this does not
 * exercise model planning, shell navigation, or voice capture.
 */
import { describe, expect, it } from "vitest";
import { MATCHER_VIEW_IDS, matchViewCommand } from "./view-command-matcher.js";
import {
	CURATED_MULTILINGUAL,
	NEGATIVE_CONTROLS,
	nounRecallCases,
} from "./view-matrix.fixtures.js";
import { resolveIntentView } from "./views-show.js";

const RECALL_CASES = nounRecallCases();

describe("view matrix — exhaustive noun recall (every view × every language noun)", () => {
	it.each(RECALL_CASES)(
		"resolves $viewId noun '$noun' under its arbitration policy",
		({ viewId, phrases, navigationOnly }) => {
			for (const [form, phrase] of Object.entries(phrases)) {
				if (navigationOnly && form !== "verb") {
					expect(matchViewCommand(phrase), `${form}: ${phrase}`).toBeNull();
					continue;
				}
				expect(matchViewCommand(phrase), `matcher ${form}: ${phrase}`).toBe(
					viewId,
				);
				expect(resolveIntentView(phrase), `intent ${form}: ${phrase}`).toBe(
					viewId,
				);
			}
		},
	);
});

describe("view matrix — every navigable view is reachable from its own nouns", () => {
	it.each(MATCHER_VIEW_IDS)(
		"view %s resolves from at least one phrase",
		(viewId) => {
			const ownCases = RECALL_CASES.filter((c) => c.viewId === viewId);
			const reachable = ownCases.some(
				(c) =>
					matchViewCommand(c.phrases.verb) === viewId ||
					matchViewCommand(c.phrases.possessive) === viewId ||
					matchViewCommand(c.phrases.bare) === viewId,
			);
			expect(reachable, `no phrase resolved to "${viewId}"`).toBe(true);
		},
	);
});

describe("view matrix — curated in-language phrases (en/es/pt/fr/de/zh/ja/ko/vi/tl)", () => {
	it.each(CURATED_MULTILINGUAL)(
		"[$lang] '$phrase' → $viewId",
		({ viewId, phrase }) => {
			expect(resolveIntentView(phrase)).toBe(viewId);
		},
	);
});

describe("view matrix — per-language negative controls never navigate", () => {
	it.each(NEGATIVE_CONTROLS)("[$lang] '$phrase' → null", ({ phrase }) => {
		expect(matchViewCommand(phrase)).toBeNull();
		expect(resolveIntentView(phrase)).toBeNull();
	});
});
