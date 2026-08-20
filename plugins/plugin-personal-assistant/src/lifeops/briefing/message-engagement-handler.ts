/**
 * Converts committed connector mutation receipts into brief engagement and
 * delayed trajectory reward. The connector owns provider I/O and emits the
 * neutral core event; this LifeOps consumer owns editorial attribution.
 */

import type { MessageMutationPayload } from "@elizaos/core";
import { LifeOpsRepository } from "../repository.js";
import { settleBriefEngagementReward } from "./engagement-reward.js";

export async function handleBriefMessageMutation(
  payload: MessageMutationPayload,
): Promise<void> {
  if (payload.messageSource !== "gmail") return;
  const eventType = payload.operation === "mark_read" ? "opened" : "replied";
  const weight = payload.operation === "mark_read" ? 0.25 : 1;
  const repository = new LifeOpsRepository(payload.runtime);
  const engagement = await repository.attributeBriefItemEngagement({
    agentId: payload.runtime.agentId,
    source: "inbox",
    sourceId: payload.messageId,
    eventType,
    eventAt: payload.committedAt,
    domainEventId: payload.domainEventId,
    weight,
  });
  if (engagement) {
    await settleBriefEngagementReward({
      runtime: payload.runtime,
      repository,
      engagement,
    });
  }
}
