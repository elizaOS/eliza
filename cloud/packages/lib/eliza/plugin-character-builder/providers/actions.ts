import type { Action, IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { addHeader, formatActions } from "@elizaos/core";

/**
 * ACTIONS provider: lists candidate response actions for the current message.
 * Types come from `@elizaos/core`; see imports above.
 */
export const actionsProvider: Provider = {
  name: "ACTIONS",
  description: "Possible response actions",
  position: -1,
  contexts: ["general", "agent_internal"],
  contextGate: { anyOf: ["general", "agent_internal"] },
  cacheStable: true,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },

  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
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

    // const actionExamples =
    //   actionsData.length > 0
    //     ? addHeader("# Action Examples", composeActionExamples(actionsData, 10))
    //     : "";

    // Combine all text sections - now including actionsWithDescriptions
    const text = [actionsWithDescriptions].filter(Boolean).join("\n\n");

    return {
      text,
      values: {
        // actionExamples,
        actionsWithDescriptions,
        formattedActionsWithDescriptions: text,
      },
      data: {
        actionsData,
      },
    };
  },
};
