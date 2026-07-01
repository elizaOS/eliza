/**
 * Coordinator Actions Provider
 *
 * Lists available actions for the coordinator to call during multi-step execution.
 */

import type {
  Action,
  ActionParameter,
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

/**
 * Formats actions with their parameter schemas for tool calling.
 */
export function formatActionsWithParams(actions: Action[]): string {
  return actions
    .map((action: Action) => {
      let formatted = `## ${action.name}\n${action.description}`;

      if (action.parameters !== undefined) {
        if (action.parameters.length === 0) {
          formatted +=
            "\n\n**Parameters:** None (can be called directly without parameters)";
        } else {
          formatted += "\n\n**Parameters:**";
          for (const parameter of action.parameters) {
            formatted += `\n- ${formatParameter(parameter)}`;
          }
        }
      }

      return formatted;
    })
    .join("\n\n---\n\n");
}

function formatParameter(parameter: ActionParameter): string {
  const required = parameter.required ? "(required)" : "(optional)";
  const enumSuffix = parameter.schema.enum?.length
    ? ` [${parameter.schema.enum.join(", ")}]`
    : "";
  return `\`${parameter.name}\` ${required}: ${parameter.schema.type}${enumSuffix} - ${parameter.description}`;
}

/**
 * Formats actions with only name and description (no parameters).
 */
function formatActionsWithoutParams(actions: Action[]): string {
  return actions
    .map((action) => `## ${action.name}\n${action.description}`)
    .join("\n\n---\n\n");
}

/**
 * Coordinator Actions Provider
 *
 * Provides list of available actions that validate for the current message context.
 */
export const coordinatorActionsProvider: Provider = {
  name: "ACTIONS",
  description: "Available actions the coordinator can execute",

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
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
        ? `Available actions: ${actionsData.map((a) => a.name).join(", ")}`
        : "No actions available";

    // Actions with full parameter schemas
    const actionsWithParams =
      actionsData.length > 0
        ? `# Available Actions\n\n${formatActionsWithParams(actionsData)}`
        : "";

    // Actions with only descriptions (no parameters)
    const actionsWithDescriptions =
      actionsData.length > 0
        ? `# Available Actions\n\n${formatActionsWithoutParams(actionsData)}`
        : "";

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
      text: actionsWithParams || "No actions available.",
    };
  },
};
