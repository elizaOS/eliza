/**
 * Computes the largest usable context window a text model can run on a given
 * host, trading model weights against KV-cache growth inside the RAM budget.
 * Sizes the KV cache in the q8_0 quant the device-fit contract keys to, and
 * optionally upgrades to the more accurate f16 KV when the host has headroom to
 * do so without shrinking the window (#8809). Consumed by load-args and
 * recommendation to pick the boot context.
 */
import { ELIZA_1_MIN_LOCAL_CONTEXT } from "@elizaos/shared/local-inference";
import { estimateQuantizedKvBytesPerToken } from "./kv-spill";

const BYTES_PER_MIB = 1024 * 1024;
const CONTEXT_STEP = 4096;
const DEFAULT_WORKING_SET_MB = 1024;

// q8_0 stores the KV cache at 34 bytes / 32 elements; f16 at 2 bytes / element.
// f16 KV therefore costs ~1.88× the q8_0 per-token rate the estimate is keyed to.
const F16_OVER_Q8_0_KV_RATIO = 2 / (34 / 32);

export interface RuntimeContextFitInput {
	params: string;
	weightMb: number;
	usableMb: number;
	nativeContext: number;
	minContext?: number;
	workingSetMb?: number;
	contextStep?: number;
	/**
	 * When the host has enough headroom to run the more accurate f16 KV cache at
	 * (at least) the same window q8_0 would give, prefer f16 instead of leaving
	 * precision on the table. Opt-in — q8_0 stays the default per the device-fit
	 * contract; this only ever *upgrades* precision and never trades away context
	 * (#8809 AC#4). See CONTEXT_SCALING.md §5.
	 */
	preferAccurateKvWhenHeadroom?: boolean;
}

export interface RuntimeContextFit {
	contextSize: number;
	contextDownscaled: boolean;
	maxFittingContext: number;
	kvBytesPerToken: number;
	workingSetMb: number;
	/** The KV cache precision the chosen window was sized against. */
	kvQuant: "q8_0" | "f16";
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
	const kvBudgetBytes = kvBudgetMb * BYTES_PER_MIB;

	const q8MaxFittingContext = roundDownToStep(
		kvBudgetBytes / kvBytesPerToken,
		step,
	);
	if (q8MaxFittingContext < minContext) return null;
	const q8ContextSize = Math.min(input.nativeContext, q8MaxFittingContext);

	// Default: q8_0 KV, sized to the host. Opt-in headroom upgrade: if f16 KV
	// still affords at least the q8_0-selected window, use it — more precise, and
	// never at the cost of context.
	let kvQuant: "q8_0" | "f16" = "q8_0";
	let kvBytesPerTokenChosen = kvBytesPerToken;
	let maxFittingContext = q8MaxFittingContext;
	let contextSize = q8ContextSize;
	if (input.preferAccurateKvWhenHeadroom) {
		const f16BytesPerToken = kvBytesPerToken * F16_OVER_Q8_0_KV_RATIO;
		const f16MaxFittingContext = roundDownToStep(
			kvBudgetBytes / f16BytesPerToken,
			step,
		);
		if (f16MaxFittingContext >= q8ContextSize) {
			kvQuant = "f16";
			kvBytesPerTokenChosen = f16BytesPerToken;
			maxFittingContext = f16MaxFittingContext;
			contextSize = Math.min(input.nativeContext, f16MaxFittingContext);
		}
	}

	return {
		contextSize,
		contextDownscaled: contextSize < input.nativeContext,
		maxFittingContext,
		kvBytesPerToken: kvBytesPerTokenChosen,
		workingSetMb,
		kvQuant,
	};
}
