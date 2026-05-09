import {
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type UUID,
} from "@elizaos/core";
import { v4 } from "uuid";
import { ensureAgentStorageContext } from "./storageContext";

/**
 * DJ Tip record
 */
export interface DJTip {
  from: string;
  fromUserId: string;
  amount: number;
  currency: string;
  message?: string;
  timestamp: number;
  transactionId?: string;
  roomId?: UUID;
}

/**
 * DJ Tip Statistics
 */
export interface DJTipStats {
  totalTips: number;
  totalAmount: Record<string, number>; // {currency: amount}
  tips: DJTip[];
  topTippers: Array<{
    userId: string;
    username: string;
    totalAmount: number;
    currency: string;
    tipCount: number;
  }>;
}

const DJ_TIPS_COMPONENT_TYPE = "dj_tips";
const DJ_TIPS_ENTITY_PREFIX = "dj-tips";

function getDJTipsEntityId(runtime: IAgentRuntime): UUID {
  return createUniqueUuid(
    runtime,
    `${DJ_TIPS_ENTITY_PREFIX}-${runtime.agentId}`,
  );
}

/**
 * Track a DJ tip
 */
export async function trackDJTip(
  runtime: IAgentRuntime,
  roomId: UUID,
  tip: Omit<DJTip, "roomId">,
): Promise<void> {
  const entityId = getDJTipsEntityId(runtime);
  let component = await runtime.getComponent(
    entityId,
    DJ_TIPS_COMPONENT_TYPE,
    undefined,
    runtime.agentId,
  );

  if (!component) {
    const storageContext = await ensureAgentStorageContext(
      runtime,
      "dj-tips",
      "radio-plugin",
    );

    component = {
      id: v4() as UUID,
      entityId,
      agentId: runtime.agentId,
      roomId: storageContext.roomId,
      worldId: storageContext.worldId,
      sourceEntityId: runtime.agentId,
      type: DJ_TIPS_COMPONENT_TYPE,
      createdAt: Date.now(),
      data: {
        totalTips: 0,
        totalAmount: {},
        tips: [],
        topTippers: [],
      },
    };

    await runtime.createComponent(component);
  }

  const stats = component.data as DJTipStats;

  // Add tip
  const tipWithRoom: DJTip = { ...tip, roomId };
  stats.tips.push(tipWithRoom);
  stats.totalTips++;

  // Update total amount by currency
  if (!stats.totalAmount) stats.totalAmount = {};
  stats.totalAmount[tip.currency] =
    (stats.totalAmount[tip.currency] || 0) + tip.amount;

  // Update top tippers
  if (!stats.topTippers) stats.topTippers = [];
  const tipperIndex = stats.topTippers.findIndex(
    (t) => t.userId === tip.fromUserId,
  );

  if (tipperIndex >= 0) {
    stats.topTippers[tipperIndex].totalAmount += tip.amount;
    stats.topTippers[tipperIndex].tipCount++;
  } else {
    stats.topTippers.push({
      userId: tip.fromUserId,
      username: tip.from,
      totalAmount: tip.amount,
      currency: tip.currency,
      tipCount: 1,
    });
  }

  // Sort top tippers
  stats.topTippers.sort((a, b) => b.totalAmount - a.totalAmount);

  // Keep only last 100 tips
  if (stats.tips.length > 100) {
    stats.tips = stats.tips.slice(-100);
  }

  await runtime.updateComponent({
    ...component,
    data: stats as typeof component.data,
  });

  logger.info(`Tracked DJ tip: ${tip.amount} ${tip.currency} from ${tip.from}`);
}

/**
 * Get DJ tip statistics
 */
export async function getDJTipStats(
  runtime: IAgentRuntime,
): Promise<DJTipStats> {
  const entityId = getDJTipsEntityId(runtime);
  const component = await runtime.getComponent(
    entityId,
    DJ_TIPS_COMPONENT_TYPE,
    undefined,
    runtime.agentId,
  );

  if (!component?.data) {
    return {
      totalTips: 0,
      totalAmount: {},
      tips: [],
      topTippers: [],
    };
  }

  return component.data as DJTipStats;
}

/**
 * Get recent tips
 */
export async function getRecentTips(
  runtime: IAgentRuntime,
  limit: number = 10,
): Promise<DJTip[]> {
  const stats = await getDJTipStats(runtime);
  return stats.tips.slice(-limit).reverse();
}

/**
 * Get top tippers
 */
export async function getTopTippers(
  runtime: IAgentRuntime,
  limit: number = 10,
): Promise<DJTipStats["topTippers"]> {
  const stats = await getDJTipStats(runtime);
  return stats.topTippers.slice(0, limit);
}
