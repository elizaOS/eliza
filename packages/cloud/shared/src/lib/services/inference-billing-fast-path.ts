/**
 * Revisioned organization-balance projections and compatibility accounting
 * utilities for inference.
 *
 * Worker routes read the balance projection and use the organization Durable
 * Object lease as their pre-provider write-ahead record; the deterministic
 * debit below settles each charge after the provider responds.
 */

import { CacheTTL } from "../cache/keys";
import { logger } from "../utils/logger";
import { apiKeysService } from "./api-keys";
import { creditsService, type InferenceBalanceFence } from "./credits";
import {
  invalidateOrgBalanceHint,
  readOrgBalanceHint,
  writeOrgBalanceHint,
} from "./inference-auth-cache";
import { republishOrgBalanceHintAfterDebit } from "./inference-balance-republish";

/**
 * Options for reading the gate balance hint (see `getGateBalanceHint`).
 */
export interface GateBalanceReadOptions {
  /**
   * Worker lifetime hook for stale/full-miss revalidation. Supplying this keeps
   * every authoritative refresh observable and alive without joining it to the
   * response promise.
   */
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}

/**
 * A billing dependency (organization gate, pricing, affiliate policy) could not
 * serve this request. Retryable; a cold cache never raises it.
 */
export class InferenceBillingUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Inference billing is unavailable; retry the request", { cause });
    this.name = "InferenceBillingUnavailableError";
  }
}

export interface GateBalanceSnapshot {
  balanceUsd: number;
  balanceAt: number;
  balanceRevision: string;
}

const balanceRevalidationInFlight = new Map<string, Promise<GateBalanceSnapshot>>();

function refreshOrgBalanceHint(organizationId: string): Promise<GateBalanceSnapshot> {
  const existing = balanceRevalidationInFlight.get(organizationId);
  if (existing) return existing;

  // This timestamp marks when the authoritative read started, not when its
  // cache write completed. A delayed old query must never masquerade as newer
  // than a debit that committed while it was in flight.
  const balanceAt = Date.now();
  const refresh = creditsService
    .getOrganizationBalanceSnapshot(organizationId)
    .then(async (fresh) => {
      await writeOrgBalanceHint(organizationId, fresh.balanceUsd, balanceAt, fresh.revision);
      return {
        balanceUsd: fresh.balanceUsd,
        balanceAt,
        balanceRevision: fresh.revision,
      };
    })
    .finally(() => {
      balanceRevalidationInFlight.delete(organizationId);
    });
  balanceRevalidationInFlight.set(organizationId, refresh);
  return refresh;
}

function observeBackgroundBalanceRefresh(
  organizationId: string,
  refresh: Promise<GateBalanceSnapshot>,
): Promise<void> {
  return refresh.then(
    () => undefined,
    (error) => {
      // error-policy:J7 the inference response is deliberately independent of
      // cache refresh; log the failed hydration so the next miss can retry.
      logger.warn("[InferenceBilling] org-balance revalidation failed", {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

/**
 * Read the gate balance hint for an org, stale-while-revalidate. Serves the KV
 * hint whenever one exists; if it is older than the `orgBalance` freshness
 * window it is still returned immediately and an authoritative refresh is
 * scheduled in the background. Only a full miss blocks on the authoritative
 * read. The hint is never the monetary authority: the organization Durable
 * Object lease is revision-aware and serializes every in-flight estimate, the
 * debit settler lowers the hint after each settle, and top-ups evict it.
 */
export async function getGateBalanceHint(
  organizationId: string,
  options: GateBalanceReadOptions = {},
): Promise<GateBalanceSnapshot> {
  const hint = await readOrgBalanceHint(organizationId);
  if (hint) {
    if (Date.now() - hint.balanceAt > CacheTTL.inference.orgBalance * 1000) {
      const refresh = observeBackgroundBalanceRefresh(
        organizationId,
        refreshOrgBalanceHint(organizationId),
      );
      if (options.executionCtx) {
        options.executionCtx.waitUntil(refresh);
      } else {
        void refresh;
      }
    }
    return {
      balanceUsd: hint.balanceUsd,
      balanceAt: hint.balanceAt,
      balanceRevision: hint.balanceRevision,
    };
  }

  // A cold hint is read from the primary once (coalesced per isolate) and
  // serves this request; it never fails the request for being cold.
  return await refreshOrgBalanceHint(organizationId);
}

export interface DebitContext {
  requestId: string;
  organizationId: string;
  userId: string;
  model: string;
  provider: string;
  billingSource: string;
}

/** Authoritative result of one idempotent direct inference debit. */
export type InferenceDebitCollectionOutcome =
  | {
      status: "collected";
      attemptedAmountUsd: number;
      collectedAmountUsd: number;
      newBalanceUsd: number;
      balanceRevision: string;
      transactionId: string;
    }
  | {
      status: "uncollected";
      attemptedAmountUsd: number;
      collectedAmountUsd: 0;
      newBalanceUsd: number;
      balanceRevision: string;
      transactionId: null;
      reason: "insufficient_balance" | "below_minimum" | "org_not_found";
    };

/** Infrastructure failure while the authoritative debit outcome is unknown. */
export class InferenceDebitInfrastructureError extends Error {
  constructor(
    readonly requestId: string,
    readonly organizationId: string,
    cause: unknown,
  ) {
    super(`Inference debit failed for request ${requestId}`, { cause });
    this.name = "InferenceDebitInfrastructureError";
  }
}

/** Persisted idempotent debit does not match the logical request being settled. */
export class InferenceDebitReplayMismatchError extends Error {
  constructor(
    readonly requestId: string,
    readonly organizationId: string,
    readonly attemptedAmountUsd: number,
    readonly persistedAmountUsd: number,
  ) {
    super(`Inference debit replay mismatch for request ${requestId}`);
    this.name = "InferenceDebitReplayMismatchError";
  }
}

/**
 * Debit an inference cost and refresh the org-balance hint. On a failed debit
 * (insufficient balance — the DB forbids negative) record the uncollected
 * amount and force the org back onto the safe path. A database or transport
 * failure rejects with an explicit infrastructure error: callers must not
 * report an unknown money outcome as a successful settlement.
 *
 * Used by organization admission settlement and lease recovery.
 */
export async function debitInferenceCost(
  ctx: DebitContext,
  amountUsd: number,
  source: "inline" | "backstop" | "deferred",
  options: {
    preserveBalanceHintDuringFencedHandoff?: boolean;
    inferenceBalanceFence?: InferenceBalanceFence;
    /** Set on the one follow-up debit that collects the remaining balance. */
    collectingRemainder?: boolean;
  } = {},
): Promise<InferenceDebitCollectionOutcome> {
  if (options.preserveBalanceHintDuringFencedHandoff && !options.inferenceBalanceFence) {
    throw new InferenceDebitInfrastructureError(
      ctx.requestId,
      ctx.organizationId,
      new Error("Fenced inference debit requires an admission fence"),
    );
  }
  let result: Awaited<ReturnType<typeof creditsService.deductCredits>>;
  try {
    result = await creditsService.deductCredits({
      organizationId: ctx.organizationId,
      amount: amountUsd,
      description: `Inference (${source}): ${ctx.model}`,
      // The same server request may be retried by a post-response task or
      // claimed by a backstop after an acknowledgement loss. One key across
      // sources makes the database row the exactly-once collection gate.
      stripePaymentIntentId: `inference-debit:${ctx.organizationId}:${ctx.requestId}`,
      ...(options.preserveBalanceHintDuringFencedHandoff
        ? {
            // Keep the previous revisioned projection present until the
            // authoritative post-debit snapshot below replaces it. This opt-in
            // is valid only while the admission Durable Object still accounts
            // the active lease; legacy non-Worker debits keep normal eviction.
            preserveInferenceBalanceHint: true,
            inferenceBalanceFence: options.inferenceBalanceFence,
          }
        : {}),
      metadata: {
        user_id: ctx.userId,
        requestId: ctx.requestId,
        model: ctx.model,
        provider: ctx.provider,
        billingSource: ctx.billingSource,
        type: "inference_optimistic",
        source,
      },
    });
  } catch (cause) {
    logger.error("[InferenceBilling] inference debit infrastructure failure", {
      organizationId: ctx.organizationId,
      requestId: ctx.requestId,
      amountUsd,
      source,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    try {
      await invalidateOrgBalanceHint(ctx.organizationId);
    } catch (invalidationError) {
      // error-policy:J7 the authoritative debit failure remains the primary
      // signal; cache eviction failure is separately observable for operators.
      logger.error("[InferenceBilling] failed to invalidate balance after debit failure", {
        organizationId: ctx.organizationId,
        requestId: ctx.requestId,
        error:
          invalidationError instanceof Error
            ? invalidationError.message
            : String(invalidationError),
      });
    }
    // error-policy:J2 preserve the infrastructure cause so the waitUntil
    // boundary can surface and retry the deterministic money operation.
    throw new InferenceDebitInfrastructureError(ctx.requestId, ctx.organizationId, cause);
  }

  if (result.success) {
    const transaction = result.transaction;
    const persistedAmountUsd = transaction ? Math.abs(Number(transaction.amount)) : Number.NaN;
    const transactionMetadata =
      transaction?.metadata && typeof transaction.metadata === "object" ? transaction.metadata : {};
    if (
      !transaction ||
      transaction.organization_id !== ctx.organizationId ||
      transactionMetadata.requestId !== ctx.requestId ||
      !Number.isFinite(persistedAmountUsd)
    ) {
      try {
        await invalidateOrgBalanceHint(ctx.organizationId);
      } catch (invalidationError) {
        logger.error("[InferenceBilling] failed to invalidate mismatched debit replay", {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          error:
            invalidationError instanceof Error
              ? invalidationError.message
              : String(invalidationError),
        });
      }
      throw new InferenceDebitReplayMismatchError(
        ctx.requestId,
        ctx.organizationId,
        amountUsd,
        persistedAmountUsd,
      );
    }
    if (Math.abs(persistedAmountUsd - amountUsd) > 0.000001) {
      logger.warn("[InferenceBilling] idempotent debit replay used the first committed amount", {
        organizationId: ctx.organizationId,
        requestId: ctx.requestId,
        attemptedAmountUsd: amountUsd,
        persistedAmountUsd,
      });
    }
    try {
      // For fenced debits, the Durable Object already holds this revision.
      // Publish its atomic observation directly; reading and lowering the old
      // cache value first adds no authority and writes it with an old revision.
      await republishOrgBalanceHintAfterDebit(
        ctx.organizationId,
        result.newBalance,
        result.balanceRevision,
        { publishAuthoritativeBalance: options.inferenceBalanceFence?.publishAuthoritativeBalance },
      );
    } catch (cause) {
      try {
        await invalidateOrgBalanceHint(ctx.organizationId);
      } catch (invalidationError) {
        logger.error("[InferenceBilling] failed to invalidate after balance-hint write failure", {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          error:
            invalidationError instanceof Error
              ? invalidationError.message
              : String(invalidationError),
        });
      }
      // error-policy:J2 the debit committed and is safe to replay by its
      // deterministic key; preserve the cache failure for task retry.
      throw new InferenceDebitInfrastructureError(ctx.requestId, ctx.organizationId, cause);
    }
    return {
      status: "collected",
      attemptedAmountUsd: amountUsd,
      collectedAmountUsd: persistedAmountUsd,
      newBalanceUsd: result.newBalance,
      balanceRevision: result.balanceRevision,
      transactionId: transaction.id,
    };
  }

  // The balance cannot go negative, so the whole-amount debit was refused.
  // The provider has already been paid for: collect what the organization
  // still holds under the same request identity. That leaves a zero balance,
  // so the next admission refuses instead of repeating an unpaid call.
  if (
    result.reason === "insufficient_balance" &&
    result.newBalance > 0 &&
    result.newBalance < amountUsd &&
    !options.collectingRemainder
  ) {
    const remainder = await debitInferenceCost(ctx, result.newBalance, source, {
      ...options,
      collectingRemainder: true,
    });
    if (remainder.status === "collected") {
      logger.error("[InferenceBilling] inference charge collected in part", {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        requestId: ctx.requestId,
        amountUsd,
        collectedAmountUsd: remainder.collectedAmountUsd,
        source,
      });
      void apiKeysService.invalidateInferenceContextForUser(ctx.userId).catch((error) => {
        // error-policy:J5 the settling request rewrites its own auth entry;
        // evicting the user's other keys is a best-effort acceleration.
        logger.error("[InferenceBilling] failed to invalidate user inference auth context", {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          requestId: ctx.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return { ...remainder, attemptedAmountUsd: amountUsd };
    }
    return { ...remainder, attemptedAmountUsd: amountUsd };
  }

  // Uncollected: nothing is left to collect. Record it and force the org off
  // the fast path until it tops up.
  logger.error("[InferenceBilling] uncollected inference charge", {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    requestId: ctx.requestId,
    amountUsd,
    source,
    reason: result.reason,
  });
  await invalidateOrgBalanceHint(ctx.organizationId);
  void apiKeysService.invalidateInferenceContextForUser(ctx.userId).catch((error) => {
    // error-policy:J5 - the org balance hint is already invalidated above,
    // so the next request leaves the optimistic path. User IAC eviction is
    // a best-effort acceleration here; contain cache brownouts explicitly.
    logger.error("[InferenceBilling] failed to invalidate user inference auth context", {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      requestId: ctx.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return {
    status: "uncollected",
    attemptedAmountUsd: amountUsd,
    collectedAmountUsd: 0,
    newBalanceUsd: result.newBalance,
    balanceRevision: result.balanceRevision,
    transactionId: null,
    reason: result.reason ?? "insufficient_balance",
  };
}
