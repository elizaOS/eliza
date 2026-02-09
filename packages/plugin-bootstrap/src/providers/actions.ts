import type { Action, IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import {
  addHeader,
  composeActionExamples,
  formatActionNames,
  formatActions,
  logger,
} from '@elizaos/core';

/**
 * Interface for action parameter definition
 */
interface ActionParameter {
  type: string;
  description: string;
  required?: boolean;
}

/**
 * Formats actions with their parameter schemas for multi-step workflows.
 * This provides the LLM with detailed information about what parameters each action accepts.
 *
 * @param actions - Array of actions to format
 * @returns Formatted string with action names, descriptions, and parameter schemas
 */
function formatActionsWithParams(actions: Action[]): string {
  return actions
    .map((action: Action) => {
      let formatted = `## ${action.name}\n${action.description}`;

      // Validate parameters is a non-null object (not an array)
      if (
        action.parameters !== undefined &&
        action.parameters !== null &&
        typeof action.parameters === 'object' &&
        !Array.isArray(action.parameters)
      ) {
        const validParams = Object.entries(
          action.parameters as Record<string, ActionParameter>
        ).filter(
          ([, paramDef]) =>
            paramDef !== null &&
            paramDef !== undefined &&
            typeof paramDef === 'object' &&
            'type' in paramDef &&
            typeof (paramDef as ActionParameter).type === 'string'
        );

        if (validParams.length === 0) {
          formatted += '\n\n**Parameters:** None (can be called directly without parameters)';
        } else {
          formatted += '\n\n**Parameters:**';
          for (const [paramName, paramDef] of validParams) {
            const required = paramDef.required ? '(required)' : '(optional)';
            const paramType = paramDef.type ?? 'unknown';
            const paramDesc = paramDef.description ?? 'No description provided';
            formatted += `\n- \`${paramName}\` ${required}: ${paramType} - ${paramDesc}`;
          }
        }
      }

      return formatted;
    })
    .join('\n\n---\n\n');
}

/**
 * Provider for ACTIONS - fetches possible response actions based on validation.
 *
 * @type {Provider}
 * @property {string} name - The name of the provider ("ACTIONS")
 * @property {string} description - Description of the provider ("Possible response actions")
 * @property {number} position - The position of the provider (-1)
 * @property {Function} get - Async function to get actions that validate for the given message
 */
export const actionsProvider: Provider = {
  name: 'ACTIONS',
  description: 'Possible response actions',
  position: -1,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Get actions that validate for this message (all validations run in parallel)
    const actionPromises = runtime.actions.map(async (action: Action) => {
      try {
        const result = await action.validate(runtime, message, state);
        if (result) {
          return action;
        }
      } catch (e) {
        logger.error(
          {
            src: 'plugin:bootstrap:provider:actions',
            agentId: runtime.agentId,
            action: action.name,
            error: e instanceof Error ? e.message : String(e),
          },
          'Action validation error'
        );
      }
      return null;
    });

    const resolvedActions = await Promise.all(actionPromises);
    const actionsData = resolvedActions.filter((a): a is Action => a !== null);

    // Early return for no valid actions (optimization: avoids unnecessary string operations)
    if (actionsData.length === 0) {
      return {
        data: { actionsData: [] },
        values: {
          actionNames: 'Possible response actions: none',
          actionExamples: '',
          actionsWithDescriptions: '',
          actionsWithParams: '',
        },
        text: 'Possible response actions: none',
      };
    }

    // Format action-related texts
    const actionNames = `Possible response actions: ${formatActionNames(actionsData)}`;
    const actionsWithDescriptions = addHeader('# Available Actions', formatActions(actionsData));
    const actionExamples = addHeader('# Action Examples', composeActionExamples(actionsData, 10));

    // Format actions with parameter schemas for multi-step workflows
    const actionsWithParams = addHeader(
      '# Available Actions with Parameters',
      formatActionsWithParams(actionsData)
    );

    const data = {
      actionsData,
    };

    const values = {
      actionNames,
      actionExamples,
      actionsWithDescriptions,
      actionsWithParams, // NEW: includes parameter schemas for tool calling
    };

    // Combine all text sections
    const text = [actionNames, actionsWithDescriptions, actionExamples].join('\n\n');

    return {
      data,
      values,
      text,
    };
  },
};
