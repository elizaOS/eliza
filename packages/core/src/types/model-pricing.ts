/**
 * Shared type signatures for the trajectory pricing module.
 *
 * Kept in a sibling file so the recorder can import the logger contract
 * without pulling in the price table or model registry.
 */

/**
 * Token usage shape accepted by `computeCallCostUsd`. Mirrors the
 * trajectory recorder's `RecordedStage.model.usage` and the normalized
 * adapter usage emitted from the text-handler stack.
 */
export interface TokenUsageForCost {
	promptTokens?: number;
	completionTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	totalTokens?: number;
}

/**
 * Minimal logger contract used by the pricing module. Matches the
 * structured logger shape (`logger.warn(context, message)`) the runtime
 * uses everywhere — passing the `runtime.logger` directly is fine.
 */
export interface TrajectoryRuntimeLogger {
	warn?: (context: unknown, message?: string) => void;
}
