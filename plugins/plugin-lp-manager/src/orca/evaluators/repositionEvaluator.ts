import {
  elizaLogger,
  Evaluator,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from '@elizaos/core';
import { extractAndValidateConfiguration } from '../actions/managePositions';

export const managePositionActionRetriggerEvaluator: Evaluator = {
  name: 'DEGEN_LP_REPOSITION_EVALUATOR',
  similes: ['DEGEN_LP_REPOSITION'],
  alwaysRun: true,
  description:
    'Schedules and monitors ongoing repositioning actions to ensure continuous operation.',

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: { [key: string]: unknown },
    callback?: HandlerCallback
  ) => {
    elizaLogger.log('Checking LP position status');
    if (!state) {
      state = (await runtime.composeState(message)) as State;
    } else {
      state = await runtime.updateRecentMessageState(state);
    }

    const config = await extractAndValidateConfiguration(message.content.text, runtime);
    if (!config || typeof config.intervalSeconds !== 'number' || config.intervalSeconds <= 0) {
      elizaLogger.debug(
        'Configuration is invalid, null, or does not have a valid positive value for intervalSeconds. Exiting evaluator.'
      );
      return;
    }

    const intervalMs = config.intervalSeconds * 1000;
    elizaLogger.log(`Using time threshold: ${intervalMs} milliseconds`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    await runtime.databaseAdapter.createMemory(
      {
        content: {
          text: message.content.text,
        },
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        userId: runtime.agentId,
        metadata: {
          type: 'reposition_message',
        },
      },
      'reposition_message'
    );
  },
  examples: [],
};
