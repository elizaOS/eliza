/**
 * Autonomous Agent Tick Cron Job API
 *
 * @route POST /api/cron/agent-tick - Execute agent tick
 * @access Cron (CRON_SECRET required)
 *
 * @description
 * Scheduled cron job that runs all autonomous trading agents.
 */

import {
  AgentStatus,
  AgentType,
  acquireAgentLock,
  agentRegistry,
  agentRuntimeManager,
  agentService,
  releaseAgentLock,
} from "@babylon/agents";
import {
  DistributedLockService,
  recordCronExecution,
  relayCronToStaging,
  verifyCronAuth,
} from "@babylon/api";
import type { User, UserAgentConfig } from "@babylon/db";
import { db, eq, inArray, userAgentConfigs, users } from "@babylon/db";
import { logger } from "@babylon/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// Vercel function configuration
export const maxDuration = 800;
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/agent-tick
 */
export async function GET(req: NextRequest) {
  return POST(req);
}

/**
 * POST /api/cron/agent-tick
 */
export async function POST(_req: NextRequest) {
  // Verify cron authorization
  if (!verifyCronAuth(_req, { jobName: "AgentTick" })) {
    logger.warn(
      "Unauthorized agent-tick request attempt",
      undefined,
      "AgentTick",
    );
    return NextResponse.json(
      { error: "Unauthorized cron request" },
      { status: 401 },
    );
  }

  const startTime = Date.now();
  const processId = `agent-tick-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  logger.info("Agent tick started", { processId }, "AgentTick");

  // Relay to staging if REDIRECT_CRON_STAGING is enabled
  const relayResult = await relayCronToStaging(_req, "agent-tick");
  if (relayResult.forwarded) {
    logger.info(
      "Cron execution relayed to staging - skipping local execution",
      {
        status: relayResult.status,
        error: relayResult.error,
      },
      "AgentTick",
    );
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "Relayed to staging environment",
      relayStatus: relayResult.status,
      processed: 0,
      skippedLocked: 0,
    });
  }

  // Acquire global lock
  const globalLockAcquired = await DistributedLockService.acquireLock({
    lockId: "agent-tick-global",
    durationMs: 800 * 1000,
    operation: "agent-tick-global",
    processId,
  });
  if (!globalLockAcquired) {
    logger.info(
      "Agent tick skipped - previous tick still running",
      { processId },
      "AgentTick",
    );
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "Previous tick still running",
      processed: 0,
      skippedLocked: 0,
    });
  }

  try {
    // Query for USER_CONTROLLED agents
    const registeredAgents = await agentRegistry.discoverAgents({
      types: [AgentType.USER_CONTROLLED],
      statuses: [
        AgentStatus.ACTIVE,
        AgentStatus.INITIALIZED,
        AgentStatus.REGISTERED,
      ],
      limit: 500,
    });

    // Filter agents with autonomous trading enabled
    const eligibleAgents: Array<{
      agentId: string;
      type: AgentType;
      name: string;
      user: User;
      config: UserAgentConfig | null;
    }> = [];

    const userControlledAgents = registeredAgents.filter(
      (agent) => agent.type === AgentType.USER_CONTROLLED && agent.userId,
    );
    const userIds = userControlledAgents.map((agent) => agent.userId!);

    let usersMap = new Map<string, User>();
    let configsMap = new Map<string, UserAgentConfig>();

    if (userIds.length > 0) {
      const [allUsers, allConfigs] = await Promise.all([
        db.select().from(users).where(inArray(users.id, userIds)),
        db
          .select()
          .from(userAgentConfigs)
          .where(inArray(userAgentConfigs.userId, userIds)),
      ]);

      usersMap = new Map(allUsers.map((u) => [u.id, u]));
      configsMap = new Map(allConfigs.map((c) => [c.userId, c]));
    }

    for (const agent of userControlledAgents) {
      const user = usersMap.get(agent.userId!);
      const config = configsMap.get(agent.userId!) ?? null;

      if (!user) {
        logger.warn(
          "USER_CONTROLLED agent missing user record - skipping",
          { agentId: agent.agentId, userId: agent.userId },
          "AgentTick",
        );
        continue;
      }

      // Check if autonomous trading is enabled
      if (user.isAgent && config?.autonomousTrading) {
        eligibleAgents.push({
          agentId: agent.agentId,
          type: agent.type,
          name: agent.name,
          user,
          config,
        });
      }
    }

    if (eligibleAgents.length === 0) {
      logger.info(
        "No eligible agents found to run",
        { totalRegistered: registeredAgents.length },
        "AgentTick",
      );

      return NextResponse.json({
        success: true,
        processed: 0,
        duration: Date.now() - startTime,
        results: [],
        skippedLocked: 0,
        message: "No agents found with autonomous trading enabled",
      });
    }

    logger.info(
      `Found ${eligibleAgents.length} eligible agents`,
      { userAgents: eligibleAgents.length },
      "AgentTick",
    );

    const results: Array<{
      agentId: string;
      agentType: AgentType;
      name: string;
      status: string;
      reason?: string;
      error?: string;
      duration: number;
    }> = [];
    let errors = 0;
    let skippedDueToLock = 0;

    for (const eligibleAgent of eligibleAgents) {
      const agentStartTime = Date.now();

      const lockAcquired = await acquireAgentLock(
        eligibleAgent.agentId,
        processId,
      );

      if (!lockAcquired) {
        skippedDueToLock++;
        logger.info(
          `Skipping agent ${eligibleAgent.name} - still running from previous tick`,
          { agentId: eligibleAgent.agentId },
          "AgentTick",
        );

        results.push({
          agentId: eligibleAgent.agentId,
          agentType: eligibleAgent.type,
          name: eligibleAgent.name,
          status: "skipped",
          reason: "locked",
          duration: Date.now() - agentStartTime,
        });

        continue;
      }

      try {
        // Get runtime and execute trading logic
        const _runtime = await agentRuntimeManager.getRuntime(
          eligibleAgent.agentId,
        );

        // Log tick execution
        await agentService.createLog(eligibleAgent.user.id, {
          type: "tick",
          level: "info",
          message: `Autonomous tick executed`,
          metadata: {
            duration: Date.now() - agentStartTime,
          },
        });

        // Update agent config status
        await db
          .update(userAgentConfigs)
          .set({
            lastTickAt: new Date(),
            status: "running",
            updatedAt: new Date(),
          })
          .where(eq(userAgentConfigs.userId, eligibleAgent.user.id));

        results.push({
          agentId: eligibleAgent.agentId,
          agentType: eligibleAgent.type,
          name: eligibleAgent.name,
          status: "success",
          duration: Date.now() - agentStartTime,
        });

        logger.info(
          `Agent ${eligibleAgent.name} tick completed in ${Date.now() - agentStartTime}ms`,
          { agentId: eligibleAgent.agentId },
          "AgentTick",
        );
      } catch (error) {
        errors++;
        logger.error(
          `Error processing agent ${eligibleAgent.name}`,
          {
            agentId: eligibleAgent.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "AgentTick",
        );

        results.push({
          agentId: eligibleAgent.agentId,
          agentType: eligibleAgent.type,
          name: eligibleAgent.name,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - agentStartTime,
        });
      } finally {
        await releaseAgentLock(eligibleAgent.agentId, processId);
      }
    }

    const duration = Date.now() - startTime;

    logger.info(
      `Agent tick completed in ${duration}ms`,
      {
        agentsEligible: eligibleAgents.length,
        agentsProcessed: results.length - skippedDueToLock,
        agentsSkippedLocked: skippedDueToLock,
        errors,
      },
      "AgentTick",
    );

    recordCronExecution("agent-tick", new Date(startTime), {
      success: true,
      processed: results.length - skippedDueToLock,
      errorCount: errors,
    });

    await agentService.updatePerformanceMetricsForAgents(userIds);

    return NextResponse.json({
      success: true,
      eligible: eligibleAgents.length,
      processed: results.length - skippedDueToLock,
      skippedLocked: skippedDueToLock,
      duration,
      errors,
      results,
    });
  } finally {
    await DistributedLockService.releaseLock("agent-tick-global", processId);
  }
}
