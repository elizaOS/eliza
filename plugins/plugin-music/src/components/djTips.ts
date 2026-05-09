import {
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type Metadata,
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

interface TopTipper {
  userId: string;
  username: string;
  totalAmount: number;
  currency: string;
  tipCount: number;
}

/**
 * DJ Tip Statistics
 */
export interface DJTipStats {
  totalTips: number;
  totalAmount: Record<string, number>; // {currency: amount}
  tips: DJTip[];
  topTippers: TopTipper[];
}

const DJ_TIPS_COMPONENT_TYPE = "dj_tips";
const DJ_TIPS_ENTITY_PREFIX = "dj-tips";

function getDJTipsEntityId(runtime: IAgentRuntime): UUID {
  return createUniqueUuid(
    runtime,
    `${DJ_TIPS_ENTITY_PREFIX}-${runtime.agentId}`,
  );
}

function createEmptyDJTipStats(): DJTipStats {
  return {
    totalTips: 0,
    totalAmount: {},
    tips: [],
    topTippers: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toDJTipStats(data: unknown): DJTipStats {
  if (!isRecord(data)) return createEmptyDJTipStats();
  return {
    totalTips: typeof data.totalTips === "number" ? data.totalTips : 0,
    totalAmount: isRecord(data.totalAmount)
      ? Object.fromEntries(
          Object.entries(data.totalAmount).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number",
          ),
        )
      : {},
    tips: Array.isArray(data.tips) ? (data.tips as DJTip[]) : [],
    topTippers: Array.isArray(data.topTippers)
      ? (data.topTippers as TopTipper[])
      : [],
  };
}

function statsToMetadata(stats: DJTipStats): Metadata {
  return {
    totalTips: stats.totalTips,
    totalAmount: stats.totalAmount,
    tips: stats.tips.map((tip) => ({ ...tip })),
    topTippers: stats.topTippers.map((tipper) => ({ ...tipper })),
  };
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
      data: statsToMetadata(createEmptyDJTipStats()),
    };

    await runtime.createComponent(component);
  }

  const stats = toDJTipStats(component.data);

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
    data: statsToMetadata(stats),
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
    return createEmptyDJTipStats();
  }

  return toDJTipStats(component.data);
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
