import type { Action, IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import { addHeader, composeActionExamples, formatActionNames, formatActions, logger } from '@elizaos/core';

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
          { src: 'plugin:bootstrap:provider:actions', agentId: runtime.agentId, action: action.name, error: e instanceof Error ? e.message : String(e) },
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
        },
        text: 'Possible response actions: none',
      };
    }

    // Format action-related texts
    const actionNames = `Possible response actions: ${formatActionNames(actionsData)}`;
    const actionsWithDescriptions = addHeader('# Available Actions', formatActions(actionsData));
    const actionExamples = addHeader('# Action Examples', composeActionExamples(actionsData, 10));

    const data = {
      actionsData,
    };

    const values = {
      actionNames,
      actionExamples,
      actionsWithDescriptions,
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
