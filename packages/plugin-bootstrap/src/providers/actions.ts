import type { Action, IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import { addHeader, composeActionExamples, formatActionNames, formatActions } from '@elizaos/core';

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
 * A provider object that fetches possible response actions based on the provided runtime, message, and state.
 * @type {Provider}
 * @property {string} name - The name of the provider ("ACTIONS").
 * @property {string} description - The description of the provider ("Possible response actions").
 * @property {number} position - The position of the provider (-1).
 * @property {Function} get - Asynchronous function that retrieves actions that validate for the given message.
 * @param {IAgentRuntime} runtime - The runtime object.
 * @param {Memory} message - The message memory.
 * @param {State} state - The state object.
 * @returns {Object} An object containing the actions data, values, and combined text sections.
 */
/**
 * Provider for ACTIONS
 *
 * @typedef {import('./Provider').Provider} Provider
 * @typedef {import('./Runtime').IAgentRuntime} IAgentRuntime
 * @typedef {import('./Memory').Memory} Memory
 * @typedef {import('./State').State} State
 * @typedef {import('./Action').Action} Action
 *
 * @type {Provider}
 * @property {string} name - The name of the provider
 * @property {string} description - Description of the provider
 * @property {number} position - The position of the provider
 * @property {Function} get - Asynchronous function to get actions that validate for a given message
 *
 * @param {IAgentRuntime} runtime - The agent runtime
 * @param {Memory} message - The message memory
 * @param {State} state - The state of the agent
 * @returns {Object} Object containing data, values, and text related to actions
 */
export const actionsProvider: Provider = {
  name: 'ACTIONS',
  description: 'Possible response actions',
  position: -1,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Get actions that validate for this message
    const actionPromises = runtime.actions.map(async (action: Action) => {
      try {
        const result = await action.validate(runtime, message, state);
        if (result) {
          return action;
        }
      } catch (e) {
        console.error('ACTIONS GET -> validate err', action, e);
      }
      return null;
    });

    const resolvedActions = await Promise.all(actionPromises);

    const actionsData = resolvedActions.filter(Boolean) as Action[];

    // Format action-related texts
    const actionNames = `Possible response actions: ${formatActionNames(actionsData)}`;

    const actionsWithDescriptions =
      actionsData.length > 0 ? addHeader('# Available Actions', formatActions(actionsData)) : '';

    // Format actions with parameter schemas for multi-step workflows
    const actionsWithParams =
      actionsData.length > 0
        ? addHeader('# Available Actions with Parameters', formatActionsWithParams(actionsData))
        : '';

    const actionExamples =
      actionsData.length > 0
        ? addHeader('# Action Examples', composeActionExamples(actionsData, 10))
        : '';

    const data = {
      actionsData,
    };

    const values = {
      actionNames,
      actionExamples,
      actionsWithDescriptions,
      actionsWithParams, // NEW: includes parameter schemas for tool calling
    };

    // Combine all text sections - now including actionsWithDescriptions
    const text = [actionNames, actionsWithDescriptions, actionExamples]
      .filter(Boolean)
      .join('\n\n');

    return {
      data,
      values,
      text,
    };
  },
};
