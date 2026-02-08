import {
  composeActionCallExamples,
  composeActionExamples,
  formatActionNames,
  formatActions,
} from "../../actions.ts";
import { logger } from "../../logger.ts";
import type { ActionFilterService } from "../../services/action-filter.ts";
import type {
  Action,
  IAgentRuntime,
  Memory,
  Provider,
  State,
} from "../../types/index.ts";
import { addHeader } from "../../utils.ts";

/** Validate actions in parallel; individual validator errors are caught and logged. */
async function validateActions(
  actions: Action[],
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
): Promise<Action[]> {
  const results = await Promise.all(
    actions.map(async (action) => {
      try {
        const valid = await action.validate(runtime, message, state);
        return valid ? action : null;
      } catch (err) {
        logger.warn(
          {
            src: "provider:actions",
            agentId: runtime.agentId,
            action: action.name,
            error: err instanceof Error ? err.message : String(err),
          },
          "Action validation threw — excluding action from prompt",
        );
        return null;
      }
    }),
  );
  return results.filter((a): a is Action => a !== null);
}

/** ACTIONS provider — filters by relevance (if service available), then validates. */
export const actionsProvider: Provider = {
  name: "ACTIONS",
  description: "Possible response actions",
  position: -1,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const filterService = runtime.getService<ActionFilterService>("action_filter");

    let actionsData: Action[];

    if (filterService) {
      const candidates = await filterService.filter(runtime, message, state);
      actionsData = await validateActions(candidates, runtime, message, state);
    } else {
      actionsData = await validateActions(
        runtime.actions,
        runtime,
        message,
        state,
      );
    }

    const actionNames = `Possible response actions: ${formatActionNames(actionsData)}`;

    const actionsWithDescriptions =
      actionsData.length > 0
        ? addHeader("# Available Actions", formatActions(actionsData))
        : "";

    const actionExamples =
      actionsData.length > 0
        ? addHeader("# Action Examples", composeActionExamples(actionsData, 10))
        : "";

    const actionCallExamples =
      actionsData.length > 0
        ? addHeader(
            "# Action Call Examples (with <params>)",
            composeActionCallExamples(actionsData, 5),
          )
        : "";

    const values = {
      actionNames,
      actionExamples,
      actionCallExamples,
      actionsWithDescriptions,
    };

    const text = [
      actionNames,
      actionsWithDescriptions,
      actionExamples,
      actionCallExamples,
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      data: {
        actionsData,
      },
      values,
      text,
    };
  },
};
