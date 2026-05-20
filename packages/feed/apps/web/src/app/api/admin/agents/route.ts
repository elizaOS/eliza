/**
 * Admin Agents Management API
 *
 * @route GET /api/admin/agents - Get all agents
 * @access Admin
 *
 * @description
 * Returns list of all autonomous agents with configuration, performance metrics,
 * status, and timing information. Requires admin authentication.
 *
 * @openapi
 * /api/admin/agents:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get all agents
 *     description: Returns list of all autonomous agents with stats (admin only)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Agents retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 agents:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       username:
 *                         type: string
 *                       displayName:
 *                         type: string
 *                       modelTier:
 *                         type: string
 *                       balance:
 *                         type: number
 *                       autonomousTrading:
 *                         type: boolean
 *                       autonomousPosting:
 *                         type: boolean
 *                       agentStatus:
 *                         type: string
 *                       lifetimePnL:
 *                         type: number
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/admin/agents', {
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * });
 * ```
 *
 * @see {@link /lib/api/admin-middleware} Admin middleware
 */

import {
  AgentType,
  agentRegistry,
  getExternalAgentAdapter,
} from '@feed/agents';
import {
  getClientIp,
  logAdminView,
  requireAdmin,
  withErrorHandling,
} from '@feed/api';
import {
  agentLogs,
  and,
  count,
  db,
  desc,
  eq,
  gte,
  userAgentConfigs,
  users,
} from '@feed/db';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/agents
 * Returns all autonomous agents with stats
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const admin = await requireAdmin(req);

  // Audit log the view
  logAdminView({
    adminId: admin.userId,
    ipAddress: getClientIp(req.headers) ?? undefined,
    resourceType: 'agents',
    metadata: { action: 'view_all_agents' },
  });
  // Get all agents with their configs
  const agentsWithConfigs = await db
    .select({
      user: users,
      config: userAgentConfigs,
    })
    .from(users)
    .leftJoin(userAgentConfigs, eq(users.id, userAgentConfigs.userId))
    .where(eq(users.isAgent, true))
    .orderBy(desc(userAgentConfigs.lastTickAt));

  const agents = agentsWithConfigs.map((a) => a.user);
  const configMap = new Map(
    agentsWithConfigs.filter((a) => a.config).map((a) => [a.user.id, a.config!])
  );

  // Get performance metrics for all agents
  const agentIds = agents.map((a) => a.id);
  const performanceMetrics = await db.agentPerformanceMetrics.findMany({
    where: { userId: { in: agentIds } },
  });
  const metricsMap = new Map(performanceMetrics.map((m) => [m.userId, m]));

  // Get creator names
  const creatorIds = agents.map((a) => a.managedBy).filter(Boolean) as string[];
  const creators = await db.user.findMany({
    where: { id: { in: creatorIds } },
    select: { id: true, displayName: true, username: true },
  });
  const creatorMap = new Map(
    creators.map((c) => [c.id, c.displayName || c.username])
  );

  // Get recent logs count for each agent (last 24 hours)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const logCounts = await db
    .select({
      agentUserId: agentLogs.agentUserId,
      _count: count(),
    })
    .from(agentLogs)
    .where(gte(agentLogs.createdAt, oneDayAgo))
    .groupBy(agentLogs.agentUserId);
  const logCountMap = new Map(
    logCounts.map((l) => [l.agentUserId, Number(l._count)])
  );

  // Get error counts
  const errorCounts = await db
    .select({
      agentUserId: agentLogs.agentUserId,
      _count: count(),
    })
    .from(agentLogs)
    .where(
      and(gte(agentLogs.createdAt, oneDayAgo), eq(agentLogs.level, 'error'))
    )
    .groupBy(agentLogs.agentUserId);
  const errorCountMap = new Map(
    errorCounts.map((e) => [e.agentUserId, Number(e._count)])
  );

  // Format agents
  const formattedAgents = agents.map((agent) => {
    const config = configMap.get(agent.id);
    const metrics = metricsMap.get(agent.id);
    const totalTrades = metrics?.totalTrades ?? 0;
    const profitableTrades = metrics?.profitableTrades ?? 0;
    const autonomousEnabled =
      config?.autonomousTrading ||
      config?.autonomousPosting ||
      config?.autonomousCommenting ||
      config?.autonomousDMs ||
      config?.autonomousGroupChats ||
      false;

    const winRate = totalTrades > 0 ? profitableTrades / totalTrades : 0;

    return {
      id: agent.id,
      name: agent.username || '',
      displayName: agent.displayName || agent.username || '',
      description: agent.bio || null,
      profileImageUrl: agent.profileImageUrl || null,
      creatorId: agent.managedBy || 'system',
      creatorName: agent.managedBy
        ? creatorMap.get(agent.managedBy) || null
        : 'System',
      modelTier: config?.modelTier || 'lite',
      balance: Number(agent.virtualBalance ?? 0),

      // Autonomous status
      autonomousEnabled,
      autonomousTrading: config?.autonomousTrading || false,
      autonomousPosting: config?.autonomousPosting || false,
      autonomousCommenting: config?.autonomousCommenting || false,
      autonomousDMs: config?.autonomousDMs || false,
      autonomousGroupChats: config?.autonomousGroupChats || false,

      // Performance
      lifetimePnL: Number(agent.lifetimePnL ?? 0),
      totalTrades,
      winRate,
      reputationScore: metrics?.reputationScore ?? 50,
      averageFeedbackScore: metrics?.averageFeedbackScore ?? 0,
      totalFeedbackCount: metrics?.totalFeedbackCount ?? 0,

      // Status
      agentStatus: config?.status,
      errorMessage: config?.errorMessage,
      lastTickAt: config?.lastTickAt,
      lastChatAt: config?.lastChatAt,

      // Timing
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,

      // Recent activity
      recentLogsCount: logCountMap.get(agent.id) || 0,
      recentErrorsCount: errorCountMap.get(agent.id) || 0,
    };
  });

  // Get external agents from AgentRegistry
  const externalAgents = await agentRegistry.discoverAgents({
    types: [AgentType.EXTERNAL],
  });

  const externalAgentAdapter = getExternalAgentAdapter();

  // Format external agents
  const formattedExternalAgents = externalAgents.map((agent) => {
    const connection = externalAgentAdapter.getConnectionStatus(agent.agentId);

    return {
      id: agent.agentId,
      name: agent.name,
      displayName: agent.name,
      description: agent.systemPrompt,
      profileImageUrl: null,
      creatorId: 'external',
      creatorName: 'External',
      modelTier: 'external' as const,
      balance: 0,

      // External agent specific
      type: 'EXTERNAL' as const,
      protocol: connection?.protocol || 'unknown',
      endpoint: connection?.endpoint || null,
      isHealthy: connection?.isHealthy ?? false,
      lastHealthCheck: connection?.lastHealthCheck || null,

      // Autonomous status (all false for external)
      autonomousEnabled: agent.status === 'ACTIVE',
      autonomousTrading: false,
      autonomousPosting: false,
      autonomousCommenting: false,
      autonomousDMs: false,
      autonomousGroupChats: false,

      // Performance (not tracked for external)
      lifetimePnL: 0,
      totalTrades: 0,
      winRate: 0,
      reputationScore: agent.trustLevel * 25, // Convert 0-4 scale to 0-100
      averageFeedbackScore: 0,
      totalFeedbackCount: 0,

      // Status
      agentStatus: agent.status.toLowerCase(),
      errorMessage: null,
      lastTickAt: agent.lastActiveAt,
      lastChatAt: null,

      // Timing
      createdAt: agent.registeredAt,
      updatedAt: agent.lastActiveAt || agent.registeredAt,

      // Recent activity (not tracked for external)
      recentLogsCount: 0,
      recentErrorsCount: connection?.isHealthy === false ? 1 : 0,
    };
  });

  // Combine internal and external agents
  const allAgents = [...formattedAgents, ...formattedExternalAgents];

  // Calculate stats
  const stats = {
    total: allAgents.length,
    running: allAgents.filter(
      (a) => a.autonomousEnabled && a.agentStatus === 'running'
    ).length,
    paused: allAgents.filter(
      (a) => !a.autonomousEnabled || a.agentStatus === 'paused'
    ).length,
    error: allAgents.filter(
      (a) => a.agentStatus === 'error' || a.recentErrorsCount > 0
    ).length,
    totalActions24h: Array.from(logCountMap.values()).reduce(
      (sum, count) => sum + count,
      0
    ),
    external: formattedExternalAgents.length,
    externalHealthy: formattedExternalAgents.filter((a) => a.isHealthy).length,
  };

  return NextResponse.json({
    success: true,
    data: {
      agents: allAgents,
      stats,
    },
  });
});
