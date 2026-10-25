/**
 * Settles delayed owner engagement onto the trajectory that produced a
 * delivered morning-brief item. The ledger claim is durable and idempotent;
 * trajectory logging remains diagnostic and cannot rewrite the domain action
 * that supplied the reward.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { resolveTrajectoryLogger } from "@elizaos/core";
import type {
  LifeOpsBriefItemEngagementRecord,
  LifeOpsRepository,
} from "../repository.js";

type LateRewardTrajectoryLogger = {
  applyReward: (params: {
    trajectoryId: string;
    idempotencyKey: string;
    reward: number;
    component: string;
  }) => Promise<boolean>;
};

function metadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function settleBriefEngagementReward(args: {
  runtime: IAgentRuntime;
  repository: LifeOpsRepository;
  engagement: LifeOpsBriefItemEngagementRecord;
}): Promise<boolean> {
  const trajectoryId = metadataString(args.engagement.metadata, "trajectoryId");
  if (!trajectoryId || args.engagement.weight === 0) return false;
  const logger = resolveTrajectoryLogger(
    args.runtime,
  ) as unknown as LateRewardTrajectoryLogger | null;
  if (!logger || typeof logger.applyReward !== "function") {
    return false;
  }
  const claimToken = await args.repository.claimBriefEngagementReward(
    args.engagement,
  );
  if (!claimToken) {
    return false;
  }

  try {
    const applied = await logger.applyReward({
      trajectoryId,
      idempotencyKey: `brief-engagement:${args.engagement.id}`,
      reward: args.engagement.weight,
      component: "briefEngagementReward",
    });
    if (!applied) {
      await args.repository.releaseBriefEngagementRewardClaim(
        args.engagement,
        claimToken,
      );
    } else {
      await args.repository.completeBriefEngagementRewardClaim(
        args.engagement,
        claimToken,
      );
    }
    return applied;
  } catch (error) {
    try {
      await args.repository.releaseBriefEngagementRewardClaim(
        args.engagement,
        claimToken,
      );
    } catch (releaseError) {
      // error-policy:J7 a failed telemetry retry release cannot change the
      // already-committed domain event, but both failures stay observable.
      args.runtime.reportError(
        "BriefEngagementReward.releaseClaim",
        releaseError,
        { engagementEventId: args.engagement.id, trajectoryId },
      );
    }
    throw error;
  }
}

/**
 * Drain durable non-zero engagement outcomes. This is invoked by each brief
 * run after expiry finalization, making an abandoned lease retryable even when
 * the originating domain webhook is never redelivered.
 */
export async function retryBriefEngagementRewards(args: {
  runtime: IAgentRuntime;
  repository: LifeOpsRepository;
  batchLimit?: number;
}): Promise<number> {
  const rows = await args.repository.listPendingBriefEngagementRewards(
    args.runtime.agentId,
    args.batchLimit === undefined ? {} : { limit: args.batchLimit },
  );
  let settled = 0;
  for (const engagement of rows) {
    try {
      if (
        await settleBriefEngagementReward({
          runtime: args.runtime,
          repository: args.repository,
          engagement,
        })
      ) {
        settled += 1;
      }
    } catch (error) {
      // error-policy:J7 reward telemetry is retried from the durable outcome
      // on a later brief and cannot make the current brief unavailable.
      args.runtime.reportError("BriefEngagementReward.retry", error, {
        engagementEventId: engagement.id,
      });
    }
  }
  return settled;
}
