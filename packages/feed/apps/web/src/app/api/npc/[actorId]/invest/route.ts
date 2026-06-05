/**
 * NPC Investment Actions API
 *
 * @route POST /api/npc/[actorId]/invest - Execute investment actions
 * @access Public
 *
 * @description
 * Executes investment actions for an NPC actor including portfolio monitoring,
 * rebalancing, risk management, and position adjustments.
 *
 * @openapi
 * /api/npc/{actorId}/invest:
 *   post:
 *     tags:
 *       - NPC
 *     summary: Execute investment actions
 *     description: Executes investment actions for NPC actor
 *     parameters:
 *       - in: path
 *         name: actorId
 *         required: true
 *         schema:
 *           type: string
 *         description: NPC actor ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - action
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [monitor, rebalance, execute]
 *               strategy:
 *                 type: string
 *                 enum: [aggressive, conservative, balanced]
 *                 description: Optional, inferred from personality if omitted
 *               rebalanceAction:
 *                 type: object
 *                 description: Required for 'execute' action
 *     responses:
 *       200:
 *         description: Action executed successfully
 *       400:
 *         description: Invalid action or input
 *       404:
 *         description: NPC actor not found
 *
 * @example
 * ```typescript
 * await fetch(`/api/npc/${actorId}/invest`, {
 *   method: 'POST',
 *   body: JSON.stringify({ action: 'monitor' })
 * });
 * ```
 */

import {
  requireCronAuth,
  requireUserByIdentifier,
  withErrorHandling,
} from "@feed/api";
import { db } from "@feed/db";
import { NPCInvestmentManager, StaticDataRegistry } from "@feed/engine";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

interface RouteParams {
  params: Promise<{
    actorId: string;
  }>;
}

interface MonitorRequest {
  action: "monitor";
  strategy?: "aggressive" | "conservative" | "balanced";
}

interface RebalanceRequest {
  action: "rebalance";
  strategy?: "aggressive" | "conservative" | "balanced";
}

interface ExecuteRequest {
  action: "execute";
  rebalanceAction: {
    type: "open" | "close" | "resize";
    positionId?: string;
    marketType: "perp" | "prediction";
    ticker?: string;
    marketId?: string;
    side: string;
    targetSize: number;
    reason: string;
  };
}

type InvestRequest = MonitorRequest | RebalanceRequest | ExecuteRequest;

export const POST = withErrorHandling(
  async (request: NextRequest, { params }: RouteParams) => {
    requireCronAuth(request, { jobName: "NPCInvest" });

    const { actorId } = await params;

    const body = (await request.json()) as InvestRequest;

    const actor = await requireUserByIdentifier(actorId);

    const pool = await db.pool.findFirst({
      where: {
        npcActorId: actor.id,
        isActive: true,
      },
    });
    if (!pool) {
      return NextResponse.json(
        { success: false, error: "No active pool found for NPC" },
        { status: 404 },
      );
    }

    let actorPersonality: string | null = null;
    const actorDetails = StaticDataRegistry.getActor(pool.npcActorId);
    actorPersonality = actorDetails?.personality || null;

    let strategy: "aggressive" | "conservative" | "balanced" = "balanced";

    if ("strategy" in body && body.strategy) {
      strategy = body.strategy;
    } else if (actorPersonality) {
      const personalityLower = actorPersonality.toLowerCase();
      const aggressiveKeywords = ["erratic", "disaster", "memecoin", "degen"];
      const conservativeKeywords = ["vampire", "yacht", "philosopher"];

      if (aggressiveKeywords.some((kw) => personalityLower.includes(kw))) {
        strategy = "aggressive";
      } else if (
        conservativeKeywords.some((kw) => personalityLower.includes(kw))
      ) {
        strategy = "conservative";
      }
    }

    if (body.action === "monitor") {
      const actions = await NPCInvestmentManager.monitorPortfolio(
        pool.id,
        actor.id,
        strategy,
      );

      return NextResponse.json({
        success: true,
        actorId: actor.id,
        poolId: pool.id,
        strategy,
        actions,
        actionCount: actions.length,
        message:
          actions.length > 0
            ? `Found ${actions.length} recommended action(s)`
            : "Portfolio is balanced, no actions needed",
      });
    }
    if (body.action === "rebalance") {
      const actions = await NPCInvestmentManager.monitorPortfolio(
        pool.id,
        actor.id,
        strategy,
      );

      const results = [];
      for (const action of actions) {
        await NPCInvestmentManager.executeRebalanceAction(
          actor.id,
          pool.id,
          action,
        );
        results.push({ action, success: true });
      }

      return NextResponse.json({
        success: true,
        actorId: actor.id,
        poolId: pool.id,
        strategy,
        actionsExecuted: results.length,
        results,
        message: `Executed ${results.filter((r) => r.success).length} of ${results.length} actions`,
      });
    }
    await NPCInvestmentManager.executeRebalanceAction(
      actor.id,
      pool.id,
      body.rebalanceAction,
    );

    return NextResponse.json({
      success: true,
      actorId: actor.id,
      poolId: pool.id,
      action: body.rebalanceAction,
      message: `Executed ${body.rebalanceAction.type} action for ${body.rebalanceAction.ticker || body.rebalanceAction.marketId}`,
    });
  },
);
