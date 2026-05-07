import type { Action, IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { addHeader, formatActions } from "@elizaos/core";

/**
 * Provides available actions that validate for the current message context.
 */
export const actionsProvider: Provider = {
  name: "ACTIONS",
  description: "Possible response actions",
  position: -1,
  contexts: ["general", "media"],
  contextGate: { anyOf: ["general", "media"] },
  cacheStable: true,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },

  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Get actions that validate for this message
    const actionPromises = runtime.actions.map(async (action: Action) => {
      const result = await action.validate(runtime, message, state);
      if (result) {
        return action;
      }
      return null;
    });

    const resolvedActions = await Promise.all(actionPromises);

    const actionsData = resolvedActions.filter(Boolean) as Action[];

    const actionsWithDescriptions =
      actionsData.length > 0
        ? addHeader("# Available Actions", formatActions(actionsData))
        : "# Available Actions: No available actions";

    return {
      data: { actionsData },
      values: { actionsWithDescriptions },
      text: actionsWithDescriptions,
    };
  },
};
