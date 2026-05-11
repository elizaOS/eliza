/**
 * @fileoverview Public type contracts for the personality benchmark judge.
 *
 * Conventions:
 *  - All fields are required unless an axis is genuinely nullable.
 *  - `Verdict` is a closed enum: PASS, FAIL, NEEDS_REVIEW. NEEDS_REVIEW is the
 *    conservative fallback whenever sub-layers disagree. The judge never
 *    silently picks one side.
 *  - `LayerResult.confidence` is in [0,1]. Phrase-check confidence is
 *    deterministic (1.0 when regex matches, 0.0 when it does not, with a small
 *    band of 0.5 for "ambiguous" cases). LLM-judge confidence is the parsed
 *    log-prob style score the model returns or, lacking that, a fixed value.
 */

export type Verdict = "PASS" | "FAIL" | "NEEDS_REVIEW";

/** One of the five personality buckets the W3-2 scenarios will tag. */
export type Bucket =
	| "shut_up"
	| "hold_style"
	| "note_trait_unrelated"
	| "escalation"
	| "scope_global_vs_user";

/** Names of the deterministic / LLM / embedding check layers. */
export type LayerName = "phrase" | "llm_judge" | "embedding" | "trajectory";

/** A single conversation turn in a trajectory. */
export interface TrajectoryTurn {
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	/** Optional metadata used by the scope-isolated rubric (room and user identity). */
	roomId?: string;
	userId?: string;
	/** Optional role hint (admin/member) for the scope rubric. */
	userRole?: "admin" | "member" | "owner" | "guest";
	/** Optional turn index (1-indexed) the scenario author can pin expectations to. */
	turnIndex?: number;
}

/**
 * `personalityExpect` shape produced by W3-2's scenarios. Treated as
 * read-only here. Unknown fields are tolerated but ignored — the judge only
 * acts on documented keys.
 */
export interface PersonalityExpect {
	bucket: Bucket;
	/**
	 * The turn index (1-based) at which the directive was issued. For
	 * `shut_up` / `hold_style` / `note_trait_unrelated`, judging starts AFTER
	 * this turn. For `escalation`, the rubric reads the sequence of responses
	 * starting at this turn.
	 */
	directiveTurn: number;
	/** The turn index of the assistant response under test (inclusive). */
	checkTurns: number[];
	/** Optional rubric-specific options. See each rubric file for shape. */
	options?: Record<string, unknown>;
}

/** Scenario authored by W3-2 in their scenario module. */
export interface PersonalityScenario {
	id: string;
	bucket: Bucket;
	name?: string;
	description?: string;
	personalityExpect: PersonalityExpect;
	/** Trajectory recorded by the run dispatcher. May be empty until graded. */
	trajectory: TrajectoryTurn[];
	/** Optional agent identifier for the report matrix. */
	agent?: string;
}

/** Output of one check layer for one scenario. */
export interface LayerResult {
	layer: LayerName;
	verdict: Verdict;
	/** 0..1. Higher means more confident in `verdict`. */
	confidence: number;
	reason: string;
	/** Optional structured evidence (regex hit, syllable count, similarity, ...). */
	evidence?: Record<string, unknown>;
}

/** Per-scenario combined verdict. */
export interface PersonalityVerdict {
	scenarioId: string;
	bucket: Bucket;
	verdict: Verdict;
	layers: LayerResult[];
	reason: string;
	/**
	 * True only when the judge is highly confident in PASS. Used by the report
	 * to compute false-positive rate against hand-graded ground truth.
	 */
	highConfidencePass: boolean;
}

/** Input passed into the rubric runner. */
export interface RubricInput {
	scenario: PersonalityScenario;
	options: PersonalityJudgeOptions;
}

/** Top-level grading options. */
export interface PersonalityJudgeOptions {
	/** Enable LLM-judge layer. Default: true if CEREBRAS_API_KEY present. */
	enableLlm: boolean;
	/** Enable embedding fallback. Default: false (set to true if embedder configured). */
	enableEmbedding: boolean;
	/** When true, ambiguous cases become FAIL instead of NEEDS_REVIEW. */
	strict: boolean;
	/** LLM endpoint configuration. */
	llm: {
		baseUrl: string;
		apiKey: string;
		model: string;
		/** How many independent judge passes to run (≥ 2 enables double-pass cross-check). */
		passes: number;
		/** Per-request timeout in ms. */
		timeoutMs: number;
	};
}

/** Aggregate report over a batch of scenarios. */
export interface BatchReport {
	schemaVersion: "personality-bench-v1";
	generatedAt: string;
	totals: {
		scenarios: number;
		pass: number;
		fail: number;
		needsReview: number;
	};
	perBucket: Record<Bucket, { pass: number; fail: number; needsReview: number }>;
	perAgent: Record<
		string,
		Record<Bucket, { pass: number; fail: number; needsReview: number }>
	>;
	verdicts: PersonalityVerdict[];
}

/** Ground-truth row used by the calibration test suite. */
export interface CalibrationCase {
	scenario_id: string;
	bucket: Bucket;
	trajectory: TrajectoryTurn[];
	personalityExpect: PersonalityExpect;
	ground_truth: Verdict;
	reason: string;
	/** Optional: mark cases that exist primarily to probe false-positives. */
	adversarial?: boolean;
}
