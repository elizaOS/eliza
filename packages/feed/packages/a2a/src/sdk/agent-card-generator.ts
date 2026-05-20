/**
 * Agent Card Generator for Individual Agents
 * Generates A2A agent cards for specific agents
 */

import type { AgentCard } from "@a2a-js/sdk";
import { db, eq, userAgentConfigs, users } from "@feed/db";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

/**
 * Common skills for agent cards
 * Shared between async and sync generation functions
 */
const AGENT_CARD_SKILLS: Array<{
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
  inputModes: string[];
  outputModes: string[];
}> = [
  {
    id: "social",
    name: "Social Features",
    description:
      "Post, comment, like, share content. Engage with the Feed community.",
    tags: ["social", "posts", "comments"],
    examples: [
      "Create a post about Bitcoin predictions",
      "Like the latest post",
      "Comment on trending discussions",
    ],
    inputModes: ["text/plain"],
    outputModes: ["application/json"],
  },
  {
    id: "trading",
    name: "Prediction Markets",
    description: "Trade on binary prediction markets. Buy/sell YES/NO shares.",
    tags: ["trading", "markets", "predictions"],
    examples: [
      "List all active markets",
      "Buy 100 YES shares in market XYZ",
      "Check my positions",
    ],
    inputModes: ["text/plain", "application/json"],
    outputModes: ["application/json"],
  },
  {
    id: "perpetuals",
    name: "Perpetual Futures",
    description: "Trade leveraged perpetual futures on companies.",
    tags: ["perpetuals", "leverage", "trading"],
    examples: ["List perpetual markets", "Open 5x long on TECH"],
    inputModes: ["text/plain", "application/json"],
    outputModes: ["application/json"],
  },
  {
    id: "messaging",
    name: "Chat & Messaging",
    description: "Send messages, create groups, participate in chats.",
    tags: ["messaging", "chat", "dm"],
    examples: [
      "Get my chats",
      "Send a message",
      "Create a trading strategy group",
    ],
    inputModes: ["text/plain"],
    outputModes: ["application/json"],
  },
] as const;

/**
 * Create agent card object from agent data
 * Shared helper to avoid duplication
 */
function createAgentCardObject(
  agentId: string,
  agentName: string,
  agentDescription: string,
  profileImageUrl: string | null,
): AgentCard {
  return {
    protocolVersion: "0.3.0",
    name: agentName,
    description: agentDescription,
    url: `${BASE_URL}/api/agents/${agentId}/a2a`,
    preferredTransport: "JSONRPC" as const,
    additionalInterfaces: [
      {
        url: `${BASE_URL}/api/agents/${agentId}/a2a`,
        transport: "JSONRPC" as const,
      },
    ],

    provider: {
      organization: "Feed",
      url: "https://feed.market",
    },

    iconUrl: profileImageUrl || `${BASE_URL}/logo.svg`,
    version: "1.0.0",
    documentationUrl: `${BASE_URL}/docs`,

    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
    },

    securitySchemes: {},
    security: [],

    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json"],

    skills: [...AGENT_CARD_SKILLS],

    supportsAuthenticatedExtendedCard: false,
  };
}

/**
 * Generate an agent card for a specific agent
 */
export async function generateAgentCard(agentId: string): Promise<AgentCard> {
  // Get user and agent config from separate tables
  const [user] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      bio: users.bio,
      profileImageUrl: users.profileImageUrl,
      isAgent: users.isAgent,
    })
    .from(users)
    .where(eq(users.id, agentId))
    .limit(1);

  if (!user?.isAgent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  // Get agent config
  const [agentConfig] = await db
    .select({
      systemPrompt: userAgentConfigs.systemPrompt,
      personality: userAgentConfigs.personality,
      tradingStrategy: userAgentConfigs.tradingStrategy,
      a2aEnabled: userAgentConfigs.a2aEnabled,
    })
    .from(userAgentConfigs)
    .where(eq(userAgentConfigs.userId, agentId))
    .limit(1);

  if (!agentConfig?.a2aEnabled) {
    throw new Error(`Agent ${agentId} does not have A2A enabled`);
  }

  const agentName = user.displayName || `Agent ${agentId.substring(0, 8)}`;
  const agentDescription =
    user.bio || agentConfig.systemPrompt || "Autonomous agent on Feed platform";

  return createAgentCardObject(
    agentId,
    agentName,
    agentDescription,
    user.profileImageUrl,
  );
}

/**
 * Generate an agent card synchronously (for use in route handlers where agent is already loaded)
 */
export function generateAgentCardSync(agent: {
  id: string;
  displayName: string | null;
  bio: string | null;
  profileImageUrl: string | null;
  systemPrompt?: string | null;
  personality?: string | null;
  tradingStrategy?: string | null;
}): AgentCard {
  const agentName = agent.displayName || `Agent ${agent.id.substring(0, 8)}`;
  const agentDescription =
    agent.bio || agent.systemPrompt || "Autonomous agent on Feed platform";

  return createAgentCardObject(
    agent.id,
    agentName,
    agentDescription,
    agent.profileImageUrl,
  );
}
