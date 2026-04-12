import { v4 as uuidv4 } from "uuid";
import { ScoreCard } from "./score-card.ts";
import type {
	ABDecision,
	ArtifactFile,
	ExecutionTrace,
	PromptKey,
	SlotKey,
} from "./types.ts";

/**
 * Simple hash function for deterministic variant selection.
 * Returns a positive integer hash suitable for modulo operations.
 */
export function simpleHash(str: string): number {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) {
		hash = (hash * 33) ^ str.charCodeAt(i);
	}
	return hash >>> 0; // Convert to unsigned 32-bit integer
}

export interface ABAnalysisResult {
	action: "promote" | "rollback" | "inconclusive";
	baselineScore: number;
	optimizedScore: number;
	pValue: number;
	sampleCount: number;
	reason: string;
}

/**
 * Deterministic variant selection based on hash of promptKey + seed.
 * Returns "optimized" for fraction of traffic = trafficSplit.
 */
export function selectVariant(
	trafficSplit: number,
	promptKey: PromptKey,
	seed: number,
): "baseline" | "optimized" {
	if (trafficSplit >= 1.0) return "optimized";
	if (trafficSplit <= 0.0) return "baseline";
	const hash = simpleHash(`${promptKey}:${seed}`);
	return hash % 10000 < Math.round(trafficSplit * 10000)
		? "optimized"
		: "baseline";
}

/**
 * Run A/B analysis on accumulated traces.
 *
 * WHY Welch's t-test: baseline and optimized traces typically have different
 * variances (early optimized traces are high-variance). Welch's t-test doesn't
 * assume equal variance, making it robust for this use case.
 *
 * WHY t-distribution CDF instead of normal approximation: with small sample
 * sizes (30–100), the normal approximation overestimates significance, leading
 * to premature promotion. The t-distribution is exact for any sample size.
 *
 * WHY auto-promote/rollback: manual A/B decisions don't scale across dozens of
 * prompt keys and models. p < 0.05 is the standard threshold for "probably not
 * a fluke."
 */
export function analyzeAB(
	baselineTraces: ExecutionTrace[],
	optimizedTraces: ExecutionTrace[],
	significanceThreshold = 0.05,
	minSamples = 30,
	signalWeights?: Record<string, number>,
): ABAnalysisResult {
	// WHY recompute instead of using stored compositeScore: traces may have been
	// scored at different times with different weights. Using stored scores would
	// mix apples and oranges, invalidating the statistical comparison. Recomputing
	// from raw signals with the same weights ensures both arms are comparable.
	const compositeOf = (t: ExecutionTrace): number => {
		if (!t.scoreCard) return 0;
		const sigs = t.scoreCard.signals;
		if (!Array.isArray(sigs) || sigs.length === 0) return 0;
		return ScoreCard.fromJSON(t.scoreCard).composite(signalWeights);
	};

	if (
		baselineTraces.length < minSamples ||
		optimizedTraces.length < minSamples
	) {
		return {
			action: "inconclusive",
			baselineScore: meanOf(baselineTraces, compositeOf),
			optimizedScore: meanOf(optimizedTraces, compositeOf),
			pValue: 1.0,
			sampleCount: baselineTraces.length + optimizedTraces.length,
			reason: `Insufficient samples: baseline=${baselineTraces.length}, optimized=${optimizedTraces.length}, min=${minSamples}`,
		};
	}

	const baselineScores = baselineTraces.map(compositeOf);
	const optimizedScores = optimizedTraces.map(compositeOf);

	const baselineMean = avg(baselineScores);
	const optimizedMean = avg(optimizedScores);
	const pValue = welchTTest(baselineScores, optimizedScores);

	const sampleCount = baselineTraces.length + optimizedTraces.length;

	if (pValue < significanceThreshold) {
		if (optimizedMean > baselineMean) {
			return {
				action: "promote",
				baselineScore: baselineMean,
				optimizedScore: optimizedMean,
				pValue,
				sampleCount,
				reason: `Optimized wins: ${optimizedMean.toFixed(3)} vs ${baselineMean.toFixed(3)}, p=${pValue.toFixed(4)}`,
			};
		} else {
			return {
				action: "rollback",
				baselineScore: baselineMean,
				optimizedScore: optimizedMean,
				pValue,
				sampleCount,
				reason: `Baseline wins: ${baselineMean.toFixed(3)} vs ${optimizedMean.toFixed(3)}, p=${pValue.toFixed(4)}`,
			};
		}
	}

	return {
		action: "inconclusive",
		baselineScore: baselineMean,
		optimizedScore: optimizedMean,
		pValue,
		sampleCount,
		reason: `No significant difference: p=${pValue.toFixed(4)} >= threshold=${significanceThreshold}`,
	};
}

/**
 * Apply an A/B decision to an artifact file.
 * Mutates the artifact's abConfig and promotionHistory in-place.
 */
export function applyABDecision(
	file: ArtifactFile,
	promptKey: PromptKey,
	result: ABAnalysisResult,
	modelSlot: SlotKey,
	modelId: string,
): ABDecision | null {
	const artifact = file[promptKey];
	if (!artifact) return null;

	const now = Date.now();

	if (result.action === "promote") {
		artifact.abConfig.trafficSplit = 1.0;
		artifact.promotionHistory.push({
			action: "promoted",
			timestamp: now,
			compositeScore: result.optimizedScore,
			sampleCount: result.sampleCount,
			reason: result.reason,
		});
	} else if (result.action === "rollback") {
		artifact.abConfig.trafficSplit = 0.0;
		artifact.promotionHistory.push({
			action: "rolled_back",
			timestamp: now,
			compositeScore: result.baselineScore,
			sampleCount: result.sampleCount,
			reason: result.reason,
		});
	} else {
		// Inconclusive: no change
		return null;
	}

	artifact.updatedAt = new Date(now).toISOString();

	const decision: ABDecision = {
		type: "ab_decision",
		id: uuidv4(),
		promptKey,
		modelSlot: modelSlot,
		modelId: modelId,
		action: result.action === "promote" ? "promoted" : "rolled_back",
		baselineScore: result.baselineScore,
		optimizedScore: result.optimizedScore,
		pValue: result.pValue,
		sampleCount: result.sampleCount,
		reason: result.reason,
		createdAt: now,
	};

	return decision;
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function meanOf(
	traces: ExecutionTrace[],
	compositeOf: (t: ExecutionTrace) => number,
): number {
	if (traces.length === 0) return 0;
	return avg(traces.map(compositeOf));
}

function avg(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((s, v) => s + v, 0) / values.length;
}

function variance(values: number[]): number {
	if (values.length < 2) return 0;
	const m = avg(values);
	return values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
}

/**
 * Welch's t-test p-value.
 * Returns 2-tailed p-value using the t-distribution CDF with Welch-Satterthwaite df.
 * Falls back to the normal approximation only when df > 120.
 */
function welchTTest(a: number[], b: number[]): number {
	const na = a.length;
	const nb = b.length;
	if (na < 2 || nb < 2) return 1.0;

	const meanA = avg(a);
	const meanB = avg(b);
	const varA = variance(a);
	const varB = variance(b);

	const se = Math.sqrt(varA / na + varB / nb);
	if (se === 0) return meanA === meanB ? 1.0 : 0.0;

	const t = Math.abs(meanA - meanB) / se;

	// Welch-Satterthwaite degrees of freedom
	const df =
		(varA / na + varB / nb) ** 2 /
		((varA / na) ** 2 / (na - 1) + (varB / nb) ** 2 / (nb - 1));

	// Use t-distribution CDF for accurate p-values regardless of sample size
	return Math.min(1.0, Math.max(0.0, 2 * (1 - tDistCDF(t, df))));
}

/**
 * CDF of the t-distribution via the regularized incomplete beta function.
 * P(T <= t | df) where T ~ t(df).
 */
function tDistCDF(t: number, df: number): number {
	// For large df the t-distribution converges to normal; use normal for df > 120
	if (df > 120) return normalCDF(t);
	// P(T <= t) = 1 - 0.5 * I(df/(df+t²); df/2, 1/2)
	const x = df / (df + t * t);
	return 1 - 0.5 * regularizedIncompleteBeta(x, df / 2, 0.5);
}

/**
 * Regularized incomplete beta function I_x(a, b) via continued fraction expansion
 * (Lentz's method). Accurate for 0 <= x <= 1, a > 0, b > 0.
 */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;

	// Use the symmetry relation when x > (a+1)/(a+b+2) for better convergence
	if (x > (a + 1) / (a + b + 2)) {
		return 1 - regularizedIncompleteBeta(1 - x, b, a);
	}

	const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
	const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;

	// Continued fraction via modified Lentz's method
	const TINY = 1e-30;
	const MAX_ITER = 200;
	let frac = TINY;
	let c = 1;
	let d = 1 - ((a + b) * x) / (a + 1);
	if (Math.abs(d) < TINY) d = TINY;
	d = 1 / d;
	frac = d;

	for (let m = 1; m <= MAX_ITER; m++) {
		// Even step
		let num = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
		d = 1 + num * d;
		if (Math.abs(d) < TINY) d = TINY;
		c = 1 + num / c;
		if (Math.abs(c) < TINY) c = TINY;
		d = 1 / d;
		frac *= d * c;

		// Odd step
		num = (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
		d = 1 + num * d;
		if (Math.abs(d) < TINY) d = TINY;
		c = 1 + num / c;
		if (Math.abs(c) < TINY) c = TINY;
		d = 1 / d;
		const delta = d * c;
		frac *= delta;

		if (Math.abs(delta - 1) < 1e-10) break;
	}

	return front * frac;
}

/**
 * Natural log of the gamma function via Lanczos approximation.
 * Accurate to ~15 decimal digits for Re(z) > 0.
 */
function lgamma(z: number): number {
	const g = 7;
	const c = [
		0.99999999999980993, 676.5203681218851, -1259.1392167224028,
		771.32342877765313, -176.61502916214059, 12.507343278686905,
		-0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
	];
	if (z < 0.5) {
		return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
	}
	z -= 1;
	let x = c[0];
	for (let i = 1; i < g + 2; i++) {
		x += c[i] / (z + i);
	}
	const t = z + g + 0.5;
	return (
		0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
	);
}

/** Standard normal CDF via rational approximation (Abramowitz & Stegun 26.2.17) */
function normalCDF(z: number): number {
	const t = 1 / (1 + 0.2316419 * Math.abs(z));
	const poly =
		t *
		(0.31938153 +
			t *
				(-0.356563782 +
					t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
	const p = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z) * poly;
	return z >= 0 ? p : 1 - p;
}
