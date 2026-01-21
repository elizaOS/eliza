/**
 * A2A Agent Card Endpoint
 *
 * @route GET /api/agents/[agentId]/card - Get agent card
 * @access Public
 *
 * @description
 * Returns A2A-compatible agent card for discovery and capability advertisement.
 * Follows Agent0 SDK v0.31.0 conventions for OASF taxonomy and A2A endpoints.
 *
 * @openapi
 * /api/agents/{agentId}/card:
 *   get:
 *     tags:
 *       - Agents
 *       - A2A Protocol
 *     summary: Get agent card
 *     description: Returns A2A agent card with capabilities, skills, domains, and endpoints
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Agent identifier
 *     responses:
 *       200:
 *         description: Agent card retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 version:
 *                   type: string
 *                   example: "1.0"
 *                 agentId:
 *                   type: string
 *                 name:
 *                   type: string
 *                 description:
 *                   type: string
 *                 endpoints:
 *                   type: object
 *                 capabilities:
 *                   type: object
 *       404:
 *         description: Agent not found
 *       500:
 *         description: Internal server error
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/agents/npc-trader-001/card');
 * const agentCard = await response.json();
 * // Use with Agent0 SDK:
 * await agent.setA2A(agentCard.endpoints.a2a);
 * ```
 *
 * @see {@link /types/agent-registry.types} AgentCard type definition
 * @see {@link https://sdk.ag0.xyz/} Agent0 SDK documentation
 */

import type { AgentCard } from "@polyagent/agents";
import { agentRegistry } from "@polyagent/agents";
import { logger } from "@polyagent/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;

  // Get agent from registry
  const agent = await agentRegistry.getAgentById(agentId);

  if (!agent) {
    return NextResponse.json(
      { error: "Agent not found", agentId },
      { status: 404 },
    );
  }

  // Check if agent already has discovery metadata
  if (agent.discoveryMetadata) {
    return NextResponse.json(agent.discoveryMetadata, { status: 200 });
  }

  // Build agent card from registration data
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

  const agentCard: AgentCard = {
    version: "1.0",
    agentId: agent.agentId,
    name: agent.name,
    description: agent.systemPrompt,
    endpoints: {
      // A2A WebSocket endpoint (future implementation)
      a2a:
        agent.capabilities.a2aEndpoint ||
        `${baseUrl}/api/agents/${agentId}/a2a`,
      // MCP HTTP endpoint (future implementation)
      mcp:
        agent.capabilities.mcpEndpoint ||
        `${baseUrl}/api/agents/${agentId}/mcp`,
      // Agent card endpoint (current implementation)
      rpc: `${baseUrl}/api/agents/${agentId}/card`,
    },
    capabilities: agent.capabilities,
    // Authentication requirements (public for now)
    authentication: {
      required: false,
      methods: [],
    },
    // Usage limits (unlimited for internal agents)
    limits: {
      rateLimit: 0, // 0 = unlimited
      costPerAction: 0, // Free for internal agents
    },
  };

  logger.info(
    `Agent card retrieved for ${agentId}`,
    {
      agentType: agent.type,
      skillsCount: agent.capabilities.skills?.length || 0,
      domainsCount: agent.capabilities.domains?.length || 0,
    },
    "AgentCard",
  );

  return NextResponse.json(agentCard, { status: 200 });
}
