/**
 * Preserves the former progressive-projection API as a disabled compatibility
 * surface. Model-facing content is never projected; callers receive count-only
 * diagnostics while final request preparation either dispatches complete input
 * or rejects it explicitly.
 */

import type { IAgentRuntime } from "../types/runtime";
import type {
	ContentProjectionBudget,
	ModelInputBudget,
} from "./model-input-budget";
import type { ToolResultProjectionStats } from "./planner-rendering";

export const PROGRESSIVE_CONTENT_PROJECTION_SETTING =
	"ELIZA_PROGRESSIVE_CONTENT_PROJECTION";

type SettingReader = Pick<IAgentRuntime, "getSetting">;

/** @deprecated Projection is permanently disabled by the prompt-integrity contract. */
export function isProgressiveContentProjectionEnabled(
	_runtime: Partial<SettingReader> | undefined,
): false {
	return false;
}

export interface ContentProjectionDiagnostics {
	enabled: boolean;
	resultCount: number;
	baselineEstimatedTokens: number;
	remainingEstimatedTokens: number;
	perResultEstimatedTokens: number;
	aggregateEstimatedTokens: number;
	pagesIncluded: number;
	pagesOmitted: number;
	omissionReasons: Record<string, number>;
}

/** @deprecated Returns complete-content diagnostics and never omission budgets. */
export function buildContentProjectionDiagnostics(args: {
	enabled: boolean;
	baselineBudget: ModelInputBudget;
	projectionBudget?: ContentProjectionBudget;
	stats: ToolResultProjectionStats;
}): ContentProjectionDiagnostics {
	return {
		enabled: false,
		resultCount: args.stats.resultCount,
		baselineEstimatedTokens: args.baselineBudget.estimatedInputTokens,
		remainingEstimatedTokens: Math.max(
			0,
			args.baselineBudget.dispatchThresholdTokens -
				args.baselineBudget.estimatedInputTokens,
		),
		perResultEstimatedTokens: 0,
		aggregateEstimatedTokens: 0,
		pagesIncluded: args.stats.pagesIncluded,
		pagesOmitted: 0,
		omissionReasons: {},
	};
}
