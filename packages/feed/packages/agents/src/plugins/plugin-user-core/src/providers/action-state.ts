/**
 * Coordinator Action State Provider
 *
 * Provides previous action results from the current multi-step execution.
 * This tracks what actions have been taken and their outcomes.
 */

import type {
  ActionResult,
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from '@elizaos/core';
import { logger } from '../../../../shared/logger';

/**
 * JSON-safe parameter value type for action parameters
 */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Typed action parameters - JSON-safe values only
 */
type ActionParameters = Record<string, JsonValue>;

/**
 * Extended action result with tracking metadata
 */
type ActionTraceResult = ActionResult & {
  actionType: string;
  parameters?: ActionParameters;
  timestamp: number;
};

/**
 * Type guard for ActionTraceResult
 * Validates that an object has the required shape
 */
function isActionTraceResult(value: unknown): value is ActionTraceResult {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.actionType === 'string' &&
    typeof obj.timestamp === 'number' &&
    typeof obj.success === 'boolean'
  );
}

/**
 * Format action results for LLM context
 */
function formatActionResults(results: ActionTraceResult[]): string {
  if (results.length === 0) {
    return 'No actions taken yet in this request.';
  }

  return results
    .map((result, index) => {
      const status = result.success ? '✓ Success' : '✗ Failed';
      let output = `${index + 1}. **${result.actionType}** - ${status}`;

      if (result.text) {
        output += `\n   Summary: ${result.text}`;
      }

      if (result.error) {
        output += `\n   Error: ${result.error}`;
      }

      if (result.values && Object.keys(result.values).length > 0) {
        const valuesStr = Object.entries(result.values)
          .map(([key, value]) => `   - ${key}: ${JSON.stringify(value)}`)
          .join('\n');
        output += `\n   Values:\n${valuesStr}`;
      }

      return output;
    })
    .join('\n\n');
}

/**
 * Coordinator Action State Provider
 *
 * Provides context about actions taken during the current multi-step execution.
 */
export const coordinatorActionStateProvider: Provider = {
  name: 'ACTION_STATE',
  description: 'Previous action results from the current execution',

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    state: State
  ): Promise<ProviderResult> => {
    // Safely validate action results from state with runtime type checking
    const rawResults = state.data?.actionResults;
    let actionResults: ActionTraceResult[] = [];

    if (Array.isArray(rawResults)) {
      actionResults = rawResults.filter(isActionTraceResult);
      // Warn if some items were filtered out due to invalid shape
      if (actionResults.length !== rawResults.length) {
        logger.warn(
          `Filtered ${rawResults.length - actionResults.length} invalid action results`,
          { totalRaw: rawResults.length, valid: actionResults.length },
          'ActionState'
        );
      }
    }

    const formattedResults = formatActionResults(actionResults);

    const completedCount = actionResults.filter((r) => r.success).length;
    const failedCount = actionResults.filter((r) => !r.success).length;

    return {
      data: {
        actionResults,
        completedCount,
        failedCount,
      },
      values: {
        actionResults: formattedResults,
        hasActionResults: actionResults.length > 0,
        completedActions: completedCount,
        failedActions: failedCount,
        totalActions: actionResults.length,
      },
      text:
        actionResults.length > 0
          ? `# Actions Taken This Request\n\n${formattedResults}`
          : 'No actions taken yet.',
    };
  },
};
