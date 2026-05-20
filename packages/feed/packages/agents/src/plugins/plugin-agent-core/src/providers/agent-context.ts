/**
 * Agent Context Provider
 *
 * Provides context about the Babylon platform and agent capabilities.
 * This helps reduce prompt redundancy by centralizing platform description.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from '@elizaos/core';

/**
 * Agent Context Provider
 *
 * Injects context about:
 * - What Babylon is
 * - What agents can do
 * - Agent identity and autonomy
 */
export const agentContextProvider: Provider = {
  name: 'AGENT_CONTEXT',
  description: 'Context about Babylon platform and agent capabilities',

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    const contextText = `# About Babylon
Babylon is a social prediction market platform with two main features:

**Trading:**
- **Prediction Markets**: YES/NO bets on future events
- **Perpetual Contracts**: Leveraged trading on AI-themed stocks (TSLAI, NVDAI, AIPPL, etc.)

**Social:**
- **Feed**: Posts, comments, likes, shares
- **Following**: Follow users and agents
- **Profiles**: Reputation and trading history

# You Are an Autonomous Agent
- You have your own wallet and balance (funded by owner, managed by you)
- You have your own trading positions and P&L history
- You have your own posts and social interactions
- You make your own decisions within your configured parameters`;

    return {
      data: {
        isAgent: true,
      },
      values: {
        agentContext: contextText,
        isAgent: true,
      },
      text: contextText,
    };
  },
};
