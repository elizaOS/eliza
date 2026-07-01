/**
 * Deterministic view-routing BENCHMARK (#8797, acceptance 8/9).
 *
 * This is the AGGREGATE grid + artifact layer on top of `view-matrix.test.ts`.
 * Where that file asserts each individual cell, this file runs the FULL fixture
 * matrix through the deterministic cascade once, computes a per-(view, language,
 * modality) accuracy grid plus overall / per-language / per-modality rollups,
 * asserts the model-free landed-accuracy floor, and optionally writes a JSON grid
 * artifact when VIEW_ROUTING_BENCHMARK_OUT is set.
 *
 * Model-free and zero-cost: every cell is `resolveIntentView` / `matchViewCommand`
 * over the single-source fixture — no LLM, no network. The accuracy assertions
 * are computed from real resolver output against a real floor; the artifact write
 * is opt-in and best-effort (a filesystem failure must not fail the benchmark,
 * but a missed accuracy floor or a false navigation always does).
 *
 * Floor justification: the exhaustive `view-matrix.test.ts` recall block already
 * passes 100% (every noun form resolves to a *registered* navigable view) and the
 * curated multilingual block lands 100% to the *expected* view. The one cell that
 * does not land on its exact expected view is a known precision-over-recall
 * tie-break (`open voice notes` → `documents`, since `notes` is a documents noun),
 * which still routes to a real navigable view. So an exact-landed floor of 0.99
 * across the curated/noun matrix is honest and non-trivial, and negative-control
 * precision must be a perfect 1.0 (zero false navigations).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MATCHER_VIEW_IDS, matchViewCommand } from "./view-command-matcher.js";
import {
	CURATED_MULTILINGUAL,
	MATRIX_LANGUAGES,
	type MatrixLanguage,
	NEGATIVE_CONTROLS,
	nounRecallCases,
} from "./view-matrix.fixtures.js";
import { resolveIntentView } from "./views-show.js";

/** The exact-landed floor across the deterministic curated/noun matrix. */
const LANDED_ACCURACY_FLOOR = 0.99;
/** Negative controls must never route — precision is binary. */
const NEGATIVE_PRECISION_FLOOR = 1;
/** Opt-in artifact path; e.g. VIEW_ROUTING_BENCHMARK_OUT=reports/view-routing/grid.json. */
const ARTIFACT_ENV = "VIEW_ROUTING_BENCHMARK_OUT";

/**
 * Resolver phrasing forms benchmarked per (view, language) cell. `verb`,
 * `possessive` and `bare` come straight from `nounRecallCases`; `voice-bare`
 * models a dictated bare noun (voice transcripts arrive as plain text, so it runs
 * through the same deterministic resolver as the bare form).
 */
const BENCH_MODALITIES = ["verb", "possessive", "bare", "voice-bare"] as const;
type BenchModality = (typeof BENCH_MODALITIES)[number];

/**
 * The matcher's noun synonyms are multilingual but the fixture does not tag each
 * noun with its language, so the exhaustive recall matrix is recorded under a
 * single `und` (language-undetermined) bucket. The curated cases carry an
 * explicit language and overlay their own per-language cells on top.
 */
type GridLanguage = MatrixLanguage | "und";

interface CellTally {
	pass: number;
	total: number;
}

type Grid = Record<
	string,
	Record<string, Partial<Record<BenchModality, CellTally>>>
>;

function tally(
	grid: Grid,
	viewId: string,
	lang: GridLanguage,
	modality: BenchModality,
	pass: boolean,
): void {
	const byLang = grid[viewId] ?? {};
	grid[viewId] = byLang;
	const byModality = byLang[lang] ?? {};
	byLang[lang] = byModality;
	const cell = byModality[modality] ?? { pass: 0, total: 0 };
	byModality[modality] = cell;
	cell.total += 1;
	if (pass) cell.pass += 1;
}

interface RollupTally {
	pass: number;
	total: number;
}

function bump(map: Map<string, RollupTally>, key: string, pass: boolean): void {
	const cur = map.get(key) ?? { pass: 0, total: 0 };
	cur.total += 1;
	if (pass) cur.pass += 1;
	map.set(key, cur);
}

function ratio(t: RollupTally): number {
	return t.total === 0 ? 0 : t.pass / t.total;
}

function rollupToObject(
	map: Map<string, RollupTally>,
): Record<string, { pass: number; total: number; accuracy: number }> {
	const out: Record<string, { pass: number; total: number; accuracy: number }> =
		{};
	for (const [key, t] of map)
		out[key] = { pass: t.pass, total: t.total, accuracy: ratio(t) };
	return out;
}

/**
 * Run the entire fixture matrix through the deterministic cascade exactly once
 * and build the grid + rollups. A cell "passes" when the resolver lands on the
 * exact expected view id.
 */
function runBenchmark(): {
	grid: Grid;
	overall: RollupTally;
	perLanguage: Map<string, RollupTally>;
	perModality: Map<string, RollupTally>;
	negativePrecision: number;
	negativeTotal: number;
	misses: string[];
} {
	const grid: Grid = {};
	const overall: RollupTally = { pass: 0, total: 0 };
	const perLanguage = new Map<string, RollupTally>();
	const perModality = new Map<string, RollupTally>();
	const misses: string[] = [];

	const record = (
		viewId: string,
		lang: GridLanguage,
		modality: BenchModality,
		phrase: string,
		resolved: string | null,
	): void => {
		const pass = resolved === viewId;
		tally(grid, viewId, lang, modality, pass);
		overall.total += 1;
		if (pass) overall.pass += 1;
		bump(perLanguage, lang, pass);
		bump(perModality, modality, pass);
		if (!pass)
			misses.push(
				`${viewId} [${lang}/${modality}] "${phrase}" -> ${resolved ?? "null"}`,
			);
	};

	// Exhaustive noun recall: every view × every multilingual noun × forms.
	for (const { viewId, phrases } of nounRecallCases()) {
		record(
			viewId,
			"und",
			"verb",
			phrases.verb,
			resolveIntentView(phrases.verb),
		);
		record(
			viewId,
			"und",
			"possessive",
			phrases.possessive,
			resolveIntentView(phrases.possessive),
		);
		record(
			viewId,
			"und",
			"bare",
			phrases.bare,
			resolveIntentView(phrases.bare),
		);
		// Voice transcripts arrive as plain text; a dictated bare noun goes through
		// the same deterministic resolver as the typed bare form.
		record(
			viewId,
			"und",
			"voice-bare",
			phrases.bare,
			resolveIntentView(phrases.bare),
		);
	}

	// Curated, fully-in-language phrases overlay explicit per-language cells.
	for (const { viewId, lang, phrase } of CURATED_MULTILINGUAL) {
		record(viewId, lang, "verb", phrase, resolveIntentView(phrase));
	}

	// Negative controls: precision check (must never route).
	let declined = 0;
	for (const { phrase } of NEGATIVE_CONTROLS) {
		if (matchViewCommand(phrase) === null && resolveIntentView(phrase) === null)
			declined += 1;
	}
	const negativeTotal = NEGATIVE_CONTROLS.length;
	const negativePrecision = negativeTotal === 0 ? 1 : declined / negativeTotal;

	return {
		grid,
		overall,
		perLanguage,
		perModality,
		negativePrecision,
		negativeTotal,
		misses,
	};
}

function resolveArtifactPath(): string {
	const override = process.env[ARTIFACT_ENV];
	if (override && override.trim().length > 0) return resolve(override.trim());
	throw new Error(`${ARTIFACT_ENV} is not set`);
}

const RESULT = runBenchmark();
const ARTIFACT_PATH = process.env[ARTIFACT_ENV]?.trim()
	? resolveArtifactPath()
	: null;

// Build the artifact payload at module load. Writing is opt-in so normal Vitest
// runs do not dirty the worktree; when requested, write best-effort so the
// accuracy assertions below remain the hard gate.
let artifactWritten = false;
let artifactError: string | null = null;
const artifact = {
	benchmark: "view-routing-deterministic",
	issue: "elizaOS/eliza#8797",
	generatedAt: new Date().toISOString(),
	model: null,
	floors: {
		landedAccuracy: LANDED_ACCURACY_FLOOR,
		negativePrecision: NEGATIVE_PRECISION_FLOOR,
	},
	languages: MATRIX_LANGUAGES,
	modalities: BENCH_MODALITIES,
	views: MATCHER_VIEW_IDS,
	summary: {
		overall: { ...RESULT.overall, accuracy: ratio(RESULT.overall) },
		perLanguage: rollupToObject(RESULT.perLanguage),
		perModality: rollupToObject(RESULT.perModality),
		negativeControls: {
			declined: Math.round(RESULT.negativePrecision * RESULT.negativeTotal),
			total: RESULT.negativeTotal,
			precision: RESULT.negativePrecision,
		},
		misses: RESULT.misses,
	},
	grid: RESULT.grid,
};

if (ARTIFACT_PATH) {
	try {
		mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
		writeFileSync(
			ARTIFACT_PATH,
			`${JSON.stringify(artifact, null, 2)}\n`,
			"utf8",
		);
		artifactWritten = true;
	} catch (err) {
		artifactError = err instanceof Error ? err.message : String(err);
	}
}

describe("view-routing benchmark — deterministic accuracy grid (#8797)", () => {
	it("evaluates a non-trivial matrix (guards against an empty/vacuous benchmark)", () => {
		// 20 navigable views × many multilingual nouns × 4 forms + 40 curated cells.
		expect(RESULT.overall.total).toBeGreaterThan(500);
		expect(MATCHER_VIEW_IDS.length).toBeGreaterThanOrEqual(19);
	});

	it(`lands ≥ ${LANDED_ACCURACY_FLOOR * 100}% overall on the deterministic matrix`, () => {
		const accuracy = ratio(RESULT.overall);
		expect(
			accuracy,
			`landed ${RESULT.overall.pass}/${RESULT.overall.total}; misses:\n${RESULT.misses.join("\n")}`,
		).toBeGreaterThanOrEqual(LANDED_ACCURACY_FLOOR);
	});

	it("never false-navigates on negative controls (precision 1.0)", () => {
		expect(
			RESULT.negativePrecision,
			`negative-control precision ${RESULT.negativePrecision}`,
		).toBeGreaterThanOrEqual(NEGATIVE_PRECISION_FLOOR);
	});

	it("clears the floor in every benchmarked language", () => {
		for (const [lang, t] of RESULT.perLanguage) {
			expect(
				ratio(t),
				`language ${lang}: ${t.pass}/${t.total}`,
			).toBeGreaterThanOrEqual(LANDED_ACCURACY_FLOOR);
		}
	});

	it("clears the floor in every benchmarked modality", () => {
		for (const [modality, t] of RESULT.perModality) {
			expect(
				ratio(t),
				`modality ${modality}: ${t.pass}/${t.total}`,
			).toBeGreaterThanOrEqual(LANDED_ACCURACY_FLOOR);
		}
	});

	it("writes the grid artifact only when explicitly requested", () => {
		if (!ARTIFACT_PATH) {
			expect(artifactWritten).toBe(false);
			expect(artifactError).toBeNull();
			return;
		}
		if (!artifactWritten) {
			// A filesystem failure is reported but is not a benchmark failure.
			expect(artifactError, "artifact write failed").not.toBeNull();
			return;
		}
		expect(existsSync(ARTIFACT_PATH)).toBe(true);
	});
});
