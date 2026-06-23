import { ELIZA_1_MIN_LOCAL_CONTEXT } from "@elizaos/shared/local-inference";
import { estimateQuantizedKvBytesPerToken } from "./kv-spill";

const BYTES_PER_MIB = 1024 * 1024;
const CONTEXT_STEP = 4096;
const DEFAULT_WORKING_SET_MB = 1024;

export interface RuntimeContextFitInput {
	params: string;
	weightMb: number;
	usableMb: number;
	nativeContext: number;
	minContext?: number;
	workingSetMb?: number;
	contextStep?: number;
}

export interface RuntimeContextFit {
	contextSize: number;
	contextDownscaled: boolean;
	maxFittingContext: number;
	kvBytesPerToken: number;
	workingSetMb: number;
}

function roundDownToStep(value: number, step: number): number {
	return Math.max(0, Math.floor(value / step) * step);
}

/**
 * Choose the runtime context window that fits the current host budget.
 *
 * The admission gate still decides whether the model may load at all. This
 * helper only sizes the q8_0 KV window for an admitted Eliza-1 tier so a tight
 * host gets the largest safe window instead of blindly taking the catalog
 * ceiling.
 */
export function computeRuntimeContextFit(
	input: RuntimeContextFitInput,
): RuntimeContextFit | null {
	const minContext = input.minContext ?? ELIZA_1_MIN_LOCAL_CONTEXT;
	const step = input.contextStep ?? CONTEXT_STEP;
	const workingSetMb = input.workingSetMb ?? DEFAULT_WORKING_SET_MB;
	if (
		!Number.isFinite(input.weightMb) ||
		!Number.isFinite(input.usableMb) ||
		!Number.isFinite(input.nativeContext) ||
		input.weightMb <= 0 ||
		input.usableMb <= 0 ||
		input.nativeContext < minContext ||
		step <= 0
	) {
		return null;
	}

	const kvBytesPerToken = estimateQuantizedKvBytesPerToken(input.params);
	if (!Number.isFinite(kvBytesPerToken) || kvBytesPerToken <= 0) return null;

	const kvBudgetMb = input.usableMb - input.weightMb - workingSetMb;
	if (kvBudgetMb <= 0) return null;

	const maxFittingContext = roundDownToStep(
		(kvBudgetMb * BYTES_PER_MIB) / kvBytesPerToken,
		step,
	);
	if (maxFittingContext < minContext) return null;

	const contextSize = Math.min(input.nativeContext, maxFittingContext);
	return {
		contextSize,
		contextDownscaled: contextSize < input.nativeContext,
		maxFittingContext,
		kvBytesPerToken,
		workingSetMb,
	};
}
