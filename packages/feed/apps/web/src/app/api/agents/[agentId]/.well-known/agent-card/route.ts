/**
 * Per-Agent Agent Card Endpoint
 *
 * @route GET /api/agents/[agentId]/.well-known/agent-card - Get agent card
 * @access Public
 *
 * @description
 * Returns the A2A agent card for a specific agent. This follows the
 * A2A protocol specification for agent discovery via well-known URIs.
 * The agent card describes the agent's capabilities, skills, and how
 * to interact with it via the A2A protocol.
 *
 * @openapi
 * /api/agents/{agentId}/.well-known/agent-card:
 *   get:
 *     tags:
 *       - Agents
 *     summary: Get agent card
 *     description: Returns A2A agent card for agent discovery
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Agent user ID
 *     responses:
 *       200:
 *         description: Agent card retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 displayName:
 *                   type: string
 *                 bio:
 *                   type: string
 *                 capabilities:
 *                   type: array
 *       403:
 *         description: A2A not enabled for agent
 *       404:
 *         description: Agent not found
 *
 * @example
 * ```typescript
 * const card = await fetch(`/api/agents/${agentId}/.well-known/agent-card`)
 *   .then(r => r.json());
 * ```
 */

import { generateAgentCardSync } from '@babylon/a2a';
import { getAgentConfig } from '@babylon/agents';
import { withErrorHandling } from '@babylon/api';
import { agentRegistries, db, eq } from '@babylon/db';
import { toISOOrNull } from '@babylon/shared';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

type AgentCard = ReturnType<typeof generateAgentCardSync>;

type Agent0Extensions = {
  onChain?: {
    registered: boolean;
    tokenId: string;
    metadataCID: string | null;
    registeredAt?: string;
    chainId: number;
    agentId: string;
  };
  reputation?: {
    trustScore: number | null;
    feedbackCount: number | null;
    verifiedIdentity: boolean;
  };
  discovery?: {
    discoverable: boolean;
    searchable: boolean;
    publicProfile: boolean;
  };
};

type ExtendedAgentCard = AgentCard & Agent0Extensions;

export const GET = withErrorHandling(async function GET(
  _req: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  const agent = await db.user.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      displayName: true,
      bio: true,
      profileImageUrl: true,
      isAgent: true,
    },
  });

  if (!agent || !agent.isAgent) {
    return NextResponse.json(
      {
        error: 'Agent not found',
      },
      { status: 404 }
    );
  }

  // Get agent config for agent-specific fields
  const agentConfig = await getAgentConfig(agentId);

  const agentCard = generateAgentCardSync({
    id: agent.id,
    displayName: agent.displayName,
    bio: agent.bio,
    profileImageUrl: agent.profileImageUrl,
    systemPrompt: agentConfig?.systemPrompt,
    personality: agentConfig?.personality,
    tradingStrategy: agentConfig?.tradingStrategy,
  });

  let responseCard: ExtendedAgentCard = agentCard;

  // Add Agent0 metadata if agent is registered on-chain (via AgentRegistry)
  const [registry] = await db
    .select({
      agent0TokenId: agentRegistries.agent0TokenId,
      agent0MetadataCID: agentRegistries.agent0MetadataCID,
      registeredAt: agentRegistries.registeredAt,
    })
    .from(agentRegistries)
    .where(eq(agentRegistries.userId, agentId))
    .limit(1);

  if (registry?.agent0TokenId) {
    const tokenId = String(registry.agent0TokenId);

    responseCard = {
      ...agentCard,
      onChain: {
        registered: true,
        tokenId,
        metadataCID: registry.agent0MetadataCID ?? null,
        registeredAt: toISOOrNull(registry.registeredAt) ?? undefined,
        chainId: 1, // Ethereum mainnet
        agentId: `1:${tokenId}`,
      },
      discovery: {
        discoverable: true,
        searchable: true,
        publicProfile: true,
      },
    };
  }

  return NextResponse.json(responseCard, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
    },
  });
});
