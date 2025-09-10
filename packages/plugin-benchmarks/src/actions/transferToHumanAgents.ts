import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';

export const transferToHumanAgents: Action = {
  name: 'TRANSFER_TO_HUMAN_AGENTS',
  description:
    "Transfer the user to a human agent when the AI agent cannot proceed. Use this action when: (1) the user explicitly requests to speak with a human agent, (2) write operations are forbidden or fail due to business rules (e.g., attempting multiple exchanges/returns on the same order when only one is allowed), (3) system limitations prevent the agent from completing the requested action, (4) complex issues that require human judgment or override of standard policies, (5) authentication or authorization failures that cannot be resolved automatically, or (6) when the user's issue cannot be resolved with the available automated tools and requires human intervention.",
  validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    return true;
  },
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const responseText =
      '✅ Success: Successfully transferred to human agent. Retail agent should safely close the conversation now.';

    // Communicate the transfer to the user
    if (callback) {
      await callback({
        text: responseText,
        source: message.content.source,
      });
    }

    return {
      success: true,
      text: responseText,
    };
  },
};
