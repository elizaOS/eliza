/**
 * Coordinator Actions Provider
 *
 * Lists available actions for the coordinator to call during multi-step execution.
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from '@elizaos/core';

/**
 * Action parameter definition
 */
interface ActionParameter {
  type: string;
  description: string;
  required: boolean;
}

/**
 * Formats actions with their parameter schemas for tool calling.
 */
export function formatActionsWithParams(actions: Action[]): string {
  return actions
    .map((action: Action) => {
      let formatted = `## ${action.name}\n${action.description}`;

      if (action.parameters !== undefined) {
        const paramEntries = Object.entries(
          action.parameters as unknown as Record<string, ActionParameter>
        );

        if (paramEntries.length === 0) {
          formatted +=
            '\n\n**Parameters:** None (can be called directly without parameters)';
        } else {
          formatted += '\n\n**Parameters:**';
          for (const [paramName, paramDef] of paramEntries) {
            const required = paramDef.required ? '(required)' : '(optional)';
            formatted += `\n- \`${paramName}\` ${required}: ${paramDef.type} - ${paramDef.description}`;
          }
        }
      }

      return formatted;
    })
    .join('\n\n---\n\n');
}

/**
 * Formats actions with only name and description (no parameters).
 */
function formatActionsWithoutParams(actions: Action[]): string {
  return actions
    .map((action) => `## ${action.name}\n${action.description}`)
    .join('\n\n---\n\n');
}

/**
 * Coordinator Actions Provider
 *
 * Provides list of available actions that validate for the current message context.
 */
export const coordinatorActionsProvider: Provider = {
  name: 'ACTIONS',
  description: 'Available actions the coordinator can execute',

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
  ): Promise<ProviderResult> => {
    // Get actions that validate for this message
    // Let validation errors propagate (fail-fast) per coding guidelines
    const actionPromises = runtime.actions.map(async (action: Action) => {
      const result = await action.validate(runtime, message, state);
      return result ? action : null;
    });

    const resolvedActions = await Promise.all(actionPromises);
    const actionsData = resolvedActions.filter(Boolean) as Action[];

    // Format action names
    const actionNames =
      actionsData.length > 0
        ? `Available actions: ${actionsData.map((a) => a.name).join(', ')}`
        : 'No actions available';

    // Actions with full parameter schemas
    const actionsWithParams =
      actionsData.length > 0
        ? `# Available Actions\n\n${formatActionsWithParams(actionsData)}`
        : '';

    // Actions with only descriptions (no parameters)
    const actionsWithDescriptions =
      actionsData.length > 0
        ? `# Available Actions\n\n${formatActionsWithoutParams(actionsData)}`
        : '';

    return {
      data: {
        actionsData,
      },
      values: {
        actionNames,
        actionsWithParams,
        actionsWithDescriptions,
        actionCount: actionsData.length,
      },
      text: actionsWithParams || 'No actions available.',
    };
  },
};
