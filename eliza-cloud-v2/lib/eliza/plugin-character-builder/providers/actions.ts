<<<<<<<< HEAD:packages/typescript/src/basic-capabilities/providers/actions.ts
import { formatActionNames, formatActions } from "../../actions.ts";
import { buildConversationSeed } from "../../deterministic";
import { requireProviderSpec } from "../../generated/spec-helpers.ts";
import { logger } from "../../logger.ts";
========
>>>>>>>> origin/odi-dev:eliza-cloud-v2/lib/eliza/plugin-character-builder/providers/actions.ts
import type {
  Action,
  IAgentRuntime,
  Memory,
  Provider,
  State,
<<<<<<<< HEAD:packages/typescript/src/basic-capabilities/providers/actions.ts
} from "../../types/index.ts";
import { addHeader } from "../../utils.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("ACTIONS");
========
} from "@elizaos/core";
import {
  addHeader,
  composeActionExamples,
  formatActionNames,
  formatActions,
} from "@elizaos/core";
>>>>>>>> origin/odi-dev:eliza-cloud-v2/lib/eliza/plugin-character-builder/providers/actions.ts

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
<<<<<<<< HEAD:packages/typescript/src/basic-capabilities/providers/actions.ts
  name: spec.name,
  description: spec.description,
  position: spec.position ?? -1,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Get actions that validate for this message
    const actionPromises = runtime.actions.map(async (action: Action) => {
      try {
        const result = await action.validate(runtime, message, state);
        if (result) {
          return action;
        }
        return null;
      } catch (error) {
        logger.warn(
          {
            src: "provider:actions",
            agentId: runtime.agentId,
            action: action.name,
            error: error instanceof Error ? error.message : String(error),
          },
          "Action validation threw — excluding action from prompt",
        );
        return null;
========
  name: "ACTIONS",
  description: "Possible response actions",
  position: -1,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Get actions that validate for this message
    const actionPromises = runtime.actions.map(async (action: Action) => {
      const result = await action.validate(runtime, message, state);
      if (result) {
        return action;
>>>>>>>> origin/odi-dev:eliza-cloud-v2/lib/eliza/plugin-character-builder/providers/actions.ts
      }
    });

    const resolvedActions = await Promise.all(actionPromises);

    const actionsData = resolvedActions.filter(Boolean) as Action[];
    const actionSeed = buildConversationSeed({
      runtime,
      message,
      state,
      surface: "provider:actions",
    });

<<<<<<<< HEAD:packages/typescript/src/basic-capabilities/providers/actions.ts
    // Format action-related texts
    const actionNames = `\n ## Possible response actions: ${formatActionNames(actionsData, `${actionSeed}:names`)}`;

    const actionsWithDescriptions =
      actionsData.length > 0
        ? addHeader(
            "# Available Actions",
            formatActions(actionsData, `${actionSeed}:descriptions`),
          )
        : "";

    const values = {
      actionNames,
      actionsWithDescriptions,
    };

    // Combine all text sections - now including actionsWithDescriptions
    const text = [actionNames, actionsWithDescriptions]
      .filter(Boolean)
      .join("\n\n");
========
    const actionsWithDescriptions =
      actionsData.length > 0
        ? addHeader("# Available Actions", formatActions(actionsData))
        : "# Available Actions: No available actions";

    // const actionExamples =
    //   actionsData.length > 0
    //     ? addHeader("# Action Examples", composeActionExamples(actionsData, 10))
    //     : "";

    const data = {
      actionsData,
    };

    // Combine all text sections - now including actionsWithDescriptions
    const text = [actionsWithDescriptions].filter(Boolean).join("\n\n");

    const values = {
      // actionExamples,
      actionsWithDescriptions,
      formattedActionsWithDescriptions: text,
    };
>>>>>>>> origin/odi-dev:eliza-cloud-v2/lib/eliza/plugin-character-builder/providers/actions.ts

    return {
      data: {
        actionsData,
      },
      values,
      text,
    };
  },
};
