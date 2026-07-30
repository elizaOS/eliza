/**
 * Binds LifeOps action text to one validated effect outcome before the shared
 * action-settlement boundary can deliver it. Callers must supply persisted
 * resource identifiers and authoritative timestamps; this module never
 * invents commit proof or substitutes request-local placeholders for a write.
 */

import {
  type ActionResult,
  type EffectIdempotency,
  type EffectReceipt,
  type EffectResourceRef,
  ElizaError,
  type HandlerCallback,
  normalizeEffectReceipt,
} from "@elizaos/core";

interface LifeOpsEffectBaseInput {
  receiptId: string;
  operation: string;
  resource: EffectResourceRef;
  artifacts: readonly EffectResourceRef[];
  idempotency: EffectIdempotency;
  observedAt: string;
}

interface LifeOpsAppliedEffectInput extends LifeOpsEffectBaseInput {
  commit: {
    kind: "durable" | "provider_accepted";
    id: string;
    committedAt: string;
  };
}

interface LifeOpsNoopEffectInput extends LifeOpsEffectBaseInput {
  reason: string;
}

interface LifeOpsFailedEffectInput extends LifeOpsEffectBaseInput {
  failure: {
    code: string;
    retryable: boolean;
    acceptance: "rejected" | "unknown";
  };
}

/** Validate durable proof supplied by the store or provider that committed it. */
export function lifeOpsAppliedEffect(
  input: LifeOpsAppliedEffectInput,
): EffectReceipt {
  return normalizeEffectReceipt({
    ...input,
    outcome: "applied",
  });
}

/** Describe a verified read/evaluation outcome without claiming a mutation. */
export function lifeOpsNoopEffect(
  input: LifeOpsNoopEffectInput,
): EffectReceipt {
  return normalizeEffectReceipt({
    ...input,
    outcome: "noop",
  });
}

/** Describe a rejected or ambiguous mutation attempt without commit proof. */
export function lifeOpsFailedEffect(
  input: LifeOpsFailedEffectInput,
): EffectReceipt {
  return normalizeEffectReceipt({
    ...input,
    outcome: "failed",
  });
}

/**
 * Make the action's exact text canonical and bind it to the supplied outcome.
 * The callback intentionally contains text only: core adds authenticated
 * receipt IDs after validating the returned result.
 */
export async function completeLifeOpsEffect(
  callback: HandlerCallback | undefined,
  result: ActionResult,
  receipt: EffectReceipt,
): Promise<ActionResult> {
  const text = result.text?.trim();
  if (!text) {
    throw new ElizaError(
      "A user-facing LifeOps effect result requires exact text",
      {
        code: "LIFEOPS_EFFECT_TEXT_REQUIRED",
        context: {},
        severity: "fatal",
      },
    );
  }
  const canonical: ActionResult = {
    ...result,
    text,
    userFacingText: text,
    verifiedUserFacing: true,
    effectReceipts: [receipt],
    userFacingEffectReceiptIds: [receipt.receiptId],
  };
  await callback?.({ text });
  return canonical;
}
