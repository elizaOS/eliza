/**
 * Resolves the progressive-content projection rollout and builds its redacted
 * per-request diagnostics. The metadata contains counts and token estimates
 * only; source text, references, paths, provider IDs, and hashes are excluded.
 */

import type { IAgentRuntime } from "../types/runtime";
import { parseBooleanValue } from "../utils/boolean";
import type {
	ContentProjectionBudget,
	ModelInputBudget,
} from "./model-input-budget";
import type { ToolResultProjectionStats } from "./planner-rendering";

export const PROGRESSIVE_CONTENT_PROJECTION_SETTING =
	"ELIZA_PROGRESSIVE_CONTENT_PROJECTION";

type SettingReader = Pick<IAgentRuntime, "getSetting">;

/** Experimental rollout is opt-in; malformed and absent settings are disabled. */
export function isProgressiveContentProjectionEnabled(
	runtime: Partial<SettingReader> | undefined,
): boolean {
	return (
		parseBooleanValue(
			runtime?.getSetting?.(PROGRESSIVE_CONTENT_PROJECTION_SETTING),
		) ?? false
	);
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

export function buildContentProjectionDiagnostics(args: {
	enabled: boolean;
	baselineBudget: ModelInputBudget;
	projectionBudget?: ContentProjectionBudget;
	stats: ToolResultProjectionStats;
}): ContentProjectionDiagnostics {
	return {
		enabled: args.enabled,
		resultCount: args.stats.resultCount,
		baselineEstimatedTokens: args.baselineBudget.estimatedInputTokens,
		remainingEstimatedTokens: Math.max(
			0,
			args.baselineBudget.compactionThresholdTokens -
				args.baselineBudget.estimatedInputTokens,
		),
		perResultEstimatedTokens: args.projectionBudget?.perResultTokens ?? 0,
		aggregateEstimatedTokens: args.projectionBudget?.aggregateTokens ?? 0,
		pagesIncluded: args.stats.pagesIncluded,
		pagesOmitted: args.stats.pagesOmitted,
		omissionReasons: { ...args.stats.omissionReasons },
	};
}
