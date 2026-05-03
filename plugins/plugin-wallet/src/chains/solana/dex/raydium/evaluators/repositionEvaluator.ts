// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import {
  type Evaluator,
  elizaLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { extractAndValidateConfiguration } from "../actions/managePositions";

export const managePositionActionRetriggerEvaluator: Evaluator = {
  name: "RAYDIUM_REPOSITION_EVALUATOR",
  similes: ["RAYDIUM_REPOSITION"],
  alwaysRun: true,
  description:
    "Schedules and monitors ongoing repositioning actions for Raydium positions to ensure continuous operation.",

  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: { [key: string]: unknown },
    _callback?: HandlerCallback
  ) => {
    elizaLogger.log("Checking Raydium LP position status");
    if (!state) {
      state = (await runtime.composeState(message)) as State;
    } else {
      state = await runtime.updateRecentMessageState(state);
    }

    const config = await extractAndValidateConfiguration(message.content.text, runtime);
    if (!config || typeof config.intervalSeconds !== "number" || config.intervalSeconds <= 0) {
      elizaLogger.debug(
        "Configuration is invalid, null, or does not have a valid positive value for intervalSeconds. Exiting evaluator."
      );
      return;
    }

    const intervalMs = config.intervalSeconds * 1000;
    elizaLogger.log(`Using time threshold: ${intervalMs} milliseconds`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    await runtime.createMemory(
      {
        content: {
          text: message.content.text,
        },
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        entityId: runtime.agentId,
        metadata: {
          type: "raydium_reposition_message",
        },
      },
      "raydium_reposition_message"
    );
  },
  examples: [],
};