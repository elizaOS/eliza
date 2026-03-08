import { formatActionNames, formatActions } from "../../actions.ts";
import { buildConversationSeed } from "../../deterministic";
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
    const filterService =
      runtime.getService<ActionFilterService>("action_filter");

    let candidateActions: Action[];

    if (filterService) {
      const rankedCandidates = await filterService.filter(
        runtime,
        message,
        state,
      );
      const rankedNames = new Set(rankedCandidates.map((a) => a.name));
      candidateActions = [
        ...rankedCandidates,
        ...runtime.actions.filter((a) => !rankedNames.has(a.name)),
      ];
    } else {
      candidateActions = runtime.actions;
    }

    const actionsData = await validateActions(
      candidateActions,
      runtime,
      message,
      state,
    );

    // Track the exact action set shown in the prompt for miss detection.
    if (filterService && message.roomId) {
      filterService.setRoomActionSet(
        message.roomId,
        actionsData.map((action) => action.name),
      );
    }

    const actionSeed = buildConversationSeed({
      runtime,
      message,
      state,
      surface: "provider:actions",
    });

    const actionNames = `Possible response actions: ${formatActionNames(actionsData, `${actionSeed}:names`)}`;

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

    const text = [actionNames, actionsWithDescriptions]
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
