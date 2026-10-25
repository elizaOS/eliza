/**
 * Reconciles one recovered Shared fallback interval (#25146) into the same
 * Dedicated runtime before routing returns to it. Only the interval's own
 * scoped journal moves, in the recovery direction; nothing is ever read from
 * Dedicated into Shared. The import is idempotent by source message id, so a
 * crash or retry at any point re-imports the same complete interval.
 */
import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";
import { logger } from "../utils/logger";
import { elizaSandboxService } from "./eliza-sandbox";
import {
  completePersonalFallbackRecovery,
  type PersonalDedicatedFallback,
} from "./personal-dedicated-fallback";
import {
  coordinateSharedCutoverCommit,
  coordinateSharedCutoverSeal,
} from "./shared-runtime/conversation-coordinator";

export type PersonalFallbackReconcileResult =
  | { reconciled: true; fallback: PersonalDedicatedFallback }
  | { reconciled: false; reason: "incomplete_journal" | "import_failed" };

export async function reconcilePersonalFallbackIntoDedicated(input: {
  fallback: PersonalDedicatedFallback;
  namespace: RuntimeDurableObjectNamespace;
}): Promise<PersonalFallbackReconcileResult> {
  const { fallback } = input;
  // Retries share one seal. Never release it on an ambiguous import/commit
  // outcome: expiry consults the exact database interval before reopening.
  const token = `fallback-recovery:${fallback.id}:${fallback.revision}`;
  const history = await coordinateSharedCutoverSeal(
    fallback.source_agent_id,
    fallback.journal_room_id,
    {
      token,
      leaseMs: 60_000,
      organizationId: fallback.organization_id,
      userId: fallback.user_id,
      dedicatedAgentId: fallback.dedicated_agent_id,
      fallback: {
        id: fallback.id,
        generation: fallback.generation,
        revision: fallback.revision,
        roomId: fallback.journal_room_id,
      },
    },
    { namespace: input.namespace },
  );
  const conversation = history.filter(
    (message): message is typeof message & { role: "user" | "assistant" } =>
      message.role === "user" || message.role === "assistant",
  );
  const messages = conversation.flatMap((message) =>
    message.id
      ? [
          {
            sourceId: message.id,
            role: message.role,
            text: message.content,
            ...(typeof message.createdAt === "number" ? { timestamp: message.createdAt } : {}),
          },
        ]
      : [],
  );
  if (messages.length !== conversation.length) {
    // Provenance is required for an idempotent, complete import; never drop
    // unidentifiable turns and call the interval reconciled.
    logger.error("[personal-dedicated-fallback] Fallback journal has unidentifiable messages", {
      fallbackId: fallback.id,
      generation: fallback.generation,
      messages: conversation.length,
      identified: messages.length,
    });
    return { reconciled: false, reason: "incomplete_journal" };
  }
  let inserted = 0;
  if (messages.length > 0) {
    const receipt = await elizaSandboxService.importCanonicalConversation(
      fallback.dedicated_agent_id,
      fallback.organization_id,
      fallback.source_agent_id,
      messages,
    );
    if (!receipt || receipt.sourceMessageCount !== messages.length) {
      logger.warn("[personal-dedicated-fallback] Fallback interval import not confirmed", {
        fallbackId: fallback.id,
        generation: fallback.generation,
        messages: messages.length,
      });
      return { reconciled: false, reason: "import_failed" };
    }
    inserted = receipt.inserted;
  }
  const recovered = await completePersonalFallbackRecovery({
    fallback,
    receipt: { sourceMessageCount: messages.length, inserted },
  });
  await coordinateSharedCutoverCommit(fallback.source_agent_id, fallback.journal_room_id, token, {
    namespace: input.namespace,
  });
  return { reconciled: true, fallback: recovered };
}
