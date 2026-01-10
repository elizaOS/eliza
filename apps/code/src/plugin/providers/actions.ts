import type {
  Action,
  IAgentRuntime,
  Memory,
  Provider,
  State,
} from "@elizaos/core";
import {
  addHeader,
  composeActionExamples,
  formatActionNames,
  formatActions,
} from "@elizaos/core";

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
  name: "ACTIONS",
  description: "Possible response actions",
  position: -1,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Descriptions are important for good action selection; keep them on by default.
    // Examples are mostly token-bloat; keep them off by default.
    const includeDescriptions = process.env.ELIZA_CODE_ACTIONS_DESCRIPTIONS !== "0";
    const includeExamples = process.env.ELIZA_CODE_ACTIONS_EXAMPLES === "1";

    // Get actions that validate for this message
    const actionPromises = runtime.actions.map(async (action: Action) => {
      try {
        const result = await action.validate(runtime, message, state);
        if (result) {
          return action;
        }
      } catch {
        // Avoid writing to stdout/stderr in the TUI; validation failures are non-fatal.
      }
      return null;
    });

    const resolvedActions = await Promise.all(actionPromises);

    const actionsData = resolvedActions.filter(Boolean) as Action[];

    // Format action-related texts
    const actionNames = `Possible response actions: ${formatActionNames(actionsData)}`;

    const actionsWithDescriptions =
      includeDescriptions && actionsData.length > 0
        ? addHeader("# Available Actions", formatActions(actionsData))
        : "";

    const actionExamples =
      includeExamples && actionsData.length > 0
        ? addHeader("# Action Examples", composeActionExamples(actionsData, 10))
        : "";

    const data = {
      actionsData,
    };

    const values = {
      actionNames,
      actionExamples,
      actionsWithDescriptions,
    };

    // Combine all text sections - now including actionsWithDescriptions
    const text = [
      actionNames,
      actionsWithDescriptions,
      actionExamples,
    ]
      .filter((s) => typeof s === "string" && s.length > 0)
      .join("\n\n");

    return {
      data,
      values,
      text,
    };
  },
};
