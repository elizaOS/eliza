import type { IAgentRuntime, Memory, State, ActionResult } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { MultiStepActionResult } from "../types";

/** Refreshes state after action execution to sync prompts with latest results. */
export async function refreshStateAfterAction(
  runtime: IAgentRuntime,
  message: Memory,
  currentState: State,
  actionResults: MultiStepActionResult[]
): Promise<State> {
  const refreshedState = await runtime.composeState(message, [
    "RECENT_MESSAGES",
    "ACTION_STATE",
  ]);

  refreshedState.data.actionResults = actionResults as ActionResult[];

  if (currentState.data?.workingMemory) {
    refreshedState.data.workingMemory = currentState.data.workingMemory;
  }

  return refreshedState;
}

/**
 * Access runtime's stateCache for action results.
 * WARNING: Uses internal ElizaOS API - may break on core version upgrades.
 * Returns empty array on failure with warning logged.
 */
export function getActionResultsFromCache(
  runtime: IAgentRuntime,
  messageId: string
): unknown[] {
  const runtimeWithCache = runtime as unknown as {
    stateCache?: Map<string, { values?: { actionResults?: unknown[] } }>;
  };

  if (!runtimeWithCache.stateCache) {
    logger.warn(
      `[getActionResultsFromCache] runtime.stateCache not found - ElizaOS internal API may have changed. ` +
      `Action results will not be captured. Check @elizaos/core version compatibility.`
    );
    return [];
  }

  const cacheKey = `${messageId}_action_results`;
  const cachedState = runtimeWithCache.stateCache.get(cacheKey);
  
  if (!cachedState) {
    logger.debug(`[getActionResultsFromCache] No cached state for key: ${cacheKey}`);
    return [];
  }

  const results = cachedState.values?.actionResults;
  if (!results) {
    logger.debug(`[getActionResultsFromCache] Cached state exists but no actionResults for: ${cacheKey}`);
    return [];
  }

  return results;
}
