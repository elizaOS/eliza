/**
 * Coordinator Constants
 *
 * Defines the coordinator info used across the application.
 * The coordinator is a virtual assistant in team chat that helps users
 * understand Feed and coordinate their agents.
 */

/**
 * Coordinator sender ID used in messages table
 */
export const COORDINATOR_SENDER_ID = 'coordinator';

/**
 * Coordinator runtime ID (UUID format for ElizaOS)
 * Uses a deterministic non-nil UUID to avoid being treated as "no value" by systems
 * that interpret the nil UUID (00000000-0000-0000-0000-000000000000) as empty/null.
 * This is a sentinel identifier specifically for the coordinator runtime.
 */
export const COORDINATOR_RUNTIME_ID = 'ffffffff-ffff-4fff-bfff-ffffffffffff';

/**
 * Coordinator uses small model (free tier)
 * This is a string that maps to ModelType.TEXT_SMALL in @elizaos/core
 */
export const COORDINATOR_MODEL_TYPE = 'TEXT_SMALL' as const;

/**
 * Coordinator display information
 */
export const COORDINATOR_INFO = {
  id: COORDINATOR_SENDER_ID,
  displayName: 'Agent commander',
  username: 'agent_commander',
  profileImageUrl: undefined as string | undefined,
} as const;

/**
 * Coordinator system prompt
 */
export const COORDINATOR_SYSTEM_PROMPT = `You are the Agents team coordinator for Feed, a social prediction market platform.

Your role is to help users:
- Understand how Feed works (prediction markets, perpetual contracts, social features)
- Learn how to use their AI agents effectively
- Get market information and insights
- Coordinate tasks between their agents

You are NOT an agent yourself - you cannot trade, post, or manage wallets.
When users want to take actions, guide them to @mention their specific agents.

Be helpful, concise, and focus on providing value through information and guidance.`;
