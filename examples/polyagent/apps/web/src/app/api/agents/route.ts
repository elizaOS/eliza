/**
 * Agents Management API
 *
 * @route POST /api/agents - Create new agent
 * @route GET /api/agents - List user's agents
 * @access Authenticated
 *
 * @description
 * Core API for creating and managing autonomous agents. Agents are special User
 * entities with AI capabilities, autonomous action permissions, and points-based
 * resource management.
 *
 * @openapi
 * /api/agents:
 *   get:
 *     tags:
 *       - Agents
 *     summary: List user agents
 *     description: Returns all agents owned by the authenticated user with performance statistics and autonomous action status.
 *     security:
 *       - PrivyAuth: []
 *     parameters:
 *       - in: query
 *         name: autonomousTrading
 *         schema:
 *           type: boolean
 *         description: Filter by autonomous trading status
 *     responses:
 *       200:
 *         description: List of agents
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 agents:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Unauthorized
 *   post:
 *     tags:
 *       - Agents
 *     summary: Create new agent
 *     description: Creates a new autonomous agent with AI capabilities, trading permissions, and points-based resource management.
 *     security:
 *       - PrivyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - system
 *             properties:
 *               name:
 *                 type: string
 *                 description: Agent display name
 *               system:
 *                 type: string
 *                 description: System prompt/instructions
 *               description:
 *                 type: string
 *               profileImageUrl:
 *                 type: string
 *               coverImageUrl:
 *                 type: string
 *               bio:
 *                 type: string
 *               personality:
 *                 type: string
 *               tradingStrategy:
 *                 type: string
 *               initialDeposit:
 *                 type: number
 *                 default: 0
 *                 description: Initial points deposit
 *     responses:
 *       200:
 *         description: Agent created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 agent:
 *                   type: object
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *
 * **Agent Capabilities:**
 * - Autonomous trading on prediction markets
 * - Social interactions (posts, comments, DMs)
 * - Group chat participation
 * - Portfolio management
 * - Multi-tier AI models (free/pro)
 *
 * **POST /api/agents - Create Agent**
 *
 * @param {string} name - Agent display name (required)
 * @param {string} system - System prompt/instructions (required)
 * @param {string} description - Agent description (optional)
 * @param {string} profileImageUrl - Profile image URL (optional)
 * @param {string} bio - Agent biography (optional)
 * @param {string} personality - Personality traits (optional)
 * @param {string} tradingStrategy - Trading strategy description (optional)
 * @param {number} initialDeposit - Initial points deposit (default: 0)
 * @param {string} modelTier - AI model tier: 'lite' | 'standard' | 'pro' (default: 'lite')
 *
 * @returns {object} Created agent with ID and configuration
 * @property {boolean} success - Operation success status
 * @property {object} agent - Agent details with performance metrics
 *
 * **GET /api/agents - List Agents**
 *
 * @query {boolean} autonomousTrading - Filter by autonomous trading status
 *
 * @returns {object} List of user's agents with performance data
 * @property {boolean} success - Operation success status
 * @property {array} agents - Array of agent objects with stats
 *
 * @throws {400} Invalid input parameters
 * @throws {401} Unauthorized - authentication required
 * @throws {500} Internal server error
 *
 * @example
 * ```typescript
 * // Create agent
 * const response = await fetch('/api/agents', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     name: 'TraderBot',
 *     system: 'You are a conservative trading agent...',
 *     modelTier: 'pro',
 *     initialDeposit: 1000
 *   })
 * });
 *
 * // List agents
 * const agents = await fetch('/api/agents?autonomousTrading=true');
 * const { agents } = await agents.json();
 * ```
 *
 * @see {@link /lib/agents/services/AgentService} Agent service implementation
 * @see {@link /src/app/agents/page.tsx} Agents management UI
 */

import { agentService, getAgentConfig } from "@polyagent/agents";
import { authenticateUser } from "@polyagent/api";
import { logger } from "@polyagent/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const user = await authenticateUser(req);

  const body = await req.json();
  const {
    name,
    username,
    description,
    profileImageUrl,
    coverImageUrl,
    system,
    bio,
    personality,
    tradingStrategy,
    initialDeposit,
    // New settings from step 3
    modelTier,
    autonomousEnabled,
    autonomousPosting,
    autonomousCommenting,
    autonomousDMs,
    autonomousGroupChats,
    a2aEnabled,
  } = body;

  const agentUser = await agentService.createAgent({
    userId: user.id,
    name,
    username,
    description,
    profileImageUrl,
    coverImageUrl,
    system,
    bio,
    personality,
    tradingStrategy,
    initialDeposit: initialDeposit || 0,
  });

  logger.info(
    `Agent user created via API: ${agentUser.id}`,
    undefined,
    "AgentsAPI",
  );

  // Update agent config with settings from step 3
  // (createAgent sets all autonomous features to true by default, so we apply user's choices here)
  await agentService.updateAgent(agentUser.id, user.id, {
    modelTier: modelTier || "free",
    autonomousTrading: autonomousEnabled ?? false,
    autonomousPosting: autonomousPosting ?? false,
    autonomousCommenting: autonomousCommenting ?? false,
    autonomousDMs: autonomousDMs ?? false,
    autonomousGroupChats: autonomousGroupChats ?? false,
    a2aEnabled: a2aEnabled ?? false,
  });

  // Get agent config for the response
  const config = await getAgentConfig(agentUser.id);

  return NextResponse.json({
    success: true,
    agent: {
      id: agentUser.id,
      username: agentUser.username,
      name: agentUser.displayName,
      description: agentUser.bio,
      profileImageUrl: agentUser.profileImageUrl,
      virtualBalance: Number(agentUser.virtualBalance ?? 0),
      autonomousTrading: config?.autonomousTrading ?? false,
      autonomousPosting: config?.autonomousPosting ?? false,
      autonomousCommenting: config?.autonomousCommenting ?? false,
      autonomousDMs: config?.autonomousDMs ?? false,
      autonomousGroupChats: config?.autonomousGroupChats ?? false,
      modelTier: config?.modelTier ?? "lite",
      lifetimePnL: agentUser.lifetimePnL.toString(),
      walletAddress: agentUser.walletAddress,
      onChainRegistered: agentUser.onChainRegistered,
      createdAt: agentUser.createdAt.toISOString(),
    },
  });
}

export async function GET(req: NextRequest) {
  const user = await authenticateUser(req);

  const { searchParams } = new URL(req.url);
  const autonomousTrading = searchParams.get("autonomousTrading");

  const filters: { autonomousTrading?: boolean } = {};
  if (autonomousTrading !== null) {
    filters.autonomousTrading = autonomousTrading === "true";
  }

  const agents = await agentService.listUserAgents(user.id, filters);

  const agentsWithStats = await Promise.all(
    agents.map(async (agent) => {
      const [performance, config] = await Promise.all([
        agentService.getPerformance(agent.id),
        getAgentConfig(agent.id),
      ]);
      return {
        id: agent.id,
        username: agent.username,
        name: agent.displayName,
        description: agent.bio,
        profileImageUrl: agent.profileImageUrl,
        virtualBalance: Number(agent.virtualBalance ?? 0),
        autonomousEnabled: config?.autonomousTrading ?? false,
        autonomousTrading: config?.autonomousTrading ?? false,
        autonomousPosting: config?.autonomousPosting ?? false,
        autonomousCommenting: config?.autonomousCommenting ?? false,
        autonomousDMs: config?.autonomousDMs ?? false,
        autonomousGroupChats: config?.autonomousGroupChats ?? false,
        modelTier: config?.modelTier ?? "lite",
        status: config?.status ?? "idle",
        isActive: config?.status === "active",
        lifetimePnL: agent.lifetimePnL.toString(),
        totalTrades: performance.totalTrades,
        profitableTrades: performance.profitableTrades,
        winRate: performance.winRate,
        lastTickAt: config?.lastTickAt?.toISOString(),
        lastChatAt: config?.lastChatAt?.toISOString(),
        walletAddress: agent.walletAddress,
        onChainRegistered: agent.onChainRegistered!,
        agent0TokenId: agent.agent0TokenId,
        createdAt: agent.createdAt.toISOString(),
        updatedAt: agent.updatedAt.toISOString(),
      };
    }),
  );

  return NextResponse.json({
    success: true,
    agents: agentsWithStats,
  });
}
