/**
 * Exhaustive deterministic view-switching matrix (#8797).
 *
 * Drives the rigid resolver (`matchViewCommand`) and the full deterministic
 * cascade (`resolveIntentView`) over the single-source matrix fixture:
 *  - every navigable view × every (multilingual) noun × {verb, possessive, bare}
 *    must resolve (recall) to a registered view;
 *  - every navigable view is reachable (resolves to itself from at least one of
 *    its own nouns);
 *  - curated fully-in-language phrases resolve to the expected view;
 *  - per-language negative controls never navigate.
 *
 * Pure + zero-cost: no model, no network. This is the CI-safe always-on layer
 * of the matrix; the live/local-model lanes stay opt-in elsewhere.
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
const ALL_VIEW_IDS = new Set(MATCHER_VIEW_IDS);

describe("view matrix — exhaustive noun recall (every view × every language noun)", () => {
	it("has a non-trivial number of generated cases (guards against an empty matrix)", () => {
		// 19 navigable views, each with many multilingual nouns.
		expect(RECALL_CASES.length).toBeGreaterThan(200);
	});

	it.each(
		RECALL_CASES,
	)("resolves $viewId noun '$noun' via verb/possessive/bare forms", ({
		phrases,
	}) => {
		// Every noun must be reachable through an explicit verb and a possessive,
		// and as a bare whole-message noun. The resolved view must be registered
		// (a higher-priority view may legitimately win a shared substring, but it
		// is always a real navigable view — never null/garbage).
		const verb = matchViewCommand(phrases.verb);
		const poss = matchViewCommand(phrases.possessive);
		const bare = matchViewCommand(phrases.bare);
		expect(verb, `verb form: "${phrases.verb}"`).not.toBeNull();
		expect(poss, `possessive form: "${phrases.possessive}"`).not.toBeNull();
		expect(bare, `bare form: "${phrases.bare}"`).not.toBeNull();
		expect(ALL_VIEW_IDS.has(verb as string)).toBe(true);
		expect(ALL_VIEW_IDS.has(poss as string)).toBe(true);
		expect(ALL_VIEW_IDS.has(bare as string)).toBe(true);
	});
});

describe("view matrix — every navigable view is reachable from its own nouns", () => {
	it.each(
		MATCHER_VIEW_IDS,
	)("view %s resolves from at least one phrase", (viewId) => {
		const ownCases = RECALL_CASES.filter((c) => c.viewId === viewId);
		expect(ownCases.length).toBeGreaterThan(0);
		const reachable = ownCases.some(
			(c) =>
				matchViewCommand(c.phrases.verb) === viewId ||
				matchViewCommand(c.phrases.possessive) === viewId ||
				matchViewCommand(c.phrases.bare) === viewId,
		);
		expect(reachable, `no phrase resolved to "${viewId}"`).toBe(true);
	});
});

describe("view matrix — curated in-language phrases (en/es/pt/fr/de/zh/ja/ko/vi/tl)", () => {
	it.each(CURATED_MULTILINGUAL)("[$lang] '$phrase' → $viewId", ({
		viewId,
		phrase,
	}) => {
		expect(resolveIntentView(phrase)).toBe(viewId);
	});

	it("covers all 10 languages for each curated domain view", () => {
		const byView = new Map<string, Set<string>>();
		for (const c of CURATED_MULTILINGUAL) {
			if (!byView.has(c.viewId)) byView.set(c.viewId, new Set());
			byView.get(c.viewId)?.add(c.lang);
		}
		for (const [, langs] of byView) {
			expect(langs.size).toBe(10);
		}
	});
});

describe("view matrix — per-language negative controls never navigate", () => {
	it.each(NEGATIVE_CONTROLS)("[$lang] '$phrase' → null", ({ phrase }) => {
		expect(matchViewCommand(phrase)).toBeNull();
		expect(resolveIntentView(phrase)).toBeNull();
	});
});
