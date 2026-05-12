/**
 * Shared types for the DSPy-style optimizers (BootstrapFewshot, COPRO,
 * MIPROv2). These intentionally mirror the legacy `optimizers/types.ts`
 * shape so artifacts written by either family round-trip with the same
 * `eliza_native_v1` reader (`packages/core/src/services/optimized-prompt.ts`).
 */

import type { Example } from "../examples.js";
import type { LanguageModelAdapter } from "../lm-adapter.js";
import type { Signature } from "../signature.js";

export type DspyOptimizerName =
	| "dspy-bootstrap-fewshot"
	| "dspy-copro"
	| "dspy-mipro";

/**
 * Metric returns a value in `[0, 1]`. `1` = exact / perfect match,
 * `0` = no credit. Optimizers average metric values across the eval set.
 */
export type Metric = (
	predicted: Record<string, unknown>,
	expected: Record<string, unknown>,
) => number;

export interface OptimizerLineageEntry {
	round: number;
	variant: number;
	score: number;
	notes?: string;
}

export interface DspyOptimizerResult {
	optimizer: DspyOptimizerName;
	signature: Signature;
	instructions: string;
	demonstrations: Example[];
	score: number;
	baselineScore: number;
	lineage: OptimizerLineageEntry[];
}

export interface DspyOptimizerInput {
	signature: Signature;
	dataset: Example[];
	lm: LanguageModelAdapter;
	metric: Metric;
	/** Optional teacher LM for proposing instruction variants. Defaults to `lm`. */
	teacher?: LanguageModelAdapter;
}
