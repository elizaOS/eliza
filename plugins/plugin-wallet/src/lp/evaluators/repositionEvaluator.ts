// @ts-nocheck — shared legacy evaluator wrapper for Solana LP reposition retriggers
import {
  type Evaluator,
  elizaLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";

interface RepositionEvaluatorConfig {
  name: string;
  similes: string[];
  description: string;
  logLabel: string;
  memoryType: string;
  extractConfiguration: (
    text: string,
    runtime: IAgentRuntime,
  ) => Promise<{ intervalSeconds?: number } | null>;
}

async function persistRetriggerMemory(
  runtime: IAgentRuntime,
  message: Memory,
  memoryType: string,
) {
  const memory = {
    content: {
      text: message.content.text,
    },
    agentId: runtime.agentId,
    roomId: runtime.agentId,
    entityId: runtime.agentId,
    userId: runtime.agentId,
    metadata: {
      type: memoryType,
    },
  };

  if (typeof runtime.createMemory === "function") {
    await runtime.createMemory(memory, memoryType);
    return;
  }

  await runtime.databaseAdapter.createMemory(memory, memoryType);
}

export function createLpRepositionEvaluator(
  config: RepositionEvaluatorConfig,
): Evaluator {
  return {
    name: config.name,
    similes: config.similes,
    alwaysRun: true,
    description: config.description,

    validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => true,

    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      state: State,
      _options: { [key: string]: unknown },
      _callback?: HandlerCallback,
    ) => {
      elizaLogger.log(`Checking ${config.logLabel} LP position status`);
      if (!state) {
        state = (await runtime.composeState(message)) as State;
      } else {
        state = await runtime.updateRecentMessageState(state);
      }

      const extracted = await config.extractConfiguration(
        message.content.text,
        runtime,
      );
      if (
        !extracted ||
        typeof extracted.intervalSeconds !== "number" ||
        extracted.intervalSeconds <= 0
      ) {
        elizaLogger.debug(
          "Configuration is invalid, null, or does not have a valid positive value for intervalSeconds. Exiting evaluator.",
        );
        return;
      }

      const intervalMs = extracted.intervalSeconds * 1000;
      elizaLogger.log(`Using time threshold: ${intervalMs} milliseconds`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));

      await persistRetriggerMemory(runtime, message, config.memoryType);
    },
    examples: [],
  };
}
