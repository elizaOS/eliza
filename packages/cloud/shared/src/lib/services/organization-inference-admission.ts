import { withCanonicalSettlementReceipt } from "./inference-settlement-receipt";
/**
 * Admission for organization-funded inference.
 *
 * Worker requests are admitted from the cached organization admission
 * snapshot (policy, billing hold, balance or subscriber funding capacity) and
 * the organization Durable Object. No Postgres read or transaction runs before
 * provider dispatch: the Durable Object lease is the only pre-provider write,
 * and post-provider accounting replays one deterministic debit or funding
 * identity under `waitUntil`, with the lease alarm as the durable backstop.
 *
 * Exactness of the cached decision comes from the standing fence in
 * `inference-policy-fence.ts`: every policy or billing-hold mutation closes the
 * organization gate before it writes and advances the policy generation the
 * snapshot carries, so a snapshot read before that mutation can never lease or
 * dispatch after it. Every other committed balance change (top-ups, refunds,
 * non-inference debits) republishes the projection to the gate, and the gate
 * keeps the newest balance revision, so affordability is decided against the
 * committed balance rather than the snapshot's. An aged snapshot still decides
 * its request and is refreshed under `waitUntil`; only a request with no
 * snapshot, or one refused for a superseded policy generation, refills inline.
 *
 * Hosts without a Worker lifetime keep a synchronous reservation because they
 * have no Durable Object to fence a deferred charge.
 */

import { ElizaError } from "@elizaos/core";
import { and, eq, isNull } from "drizzle-orm";
import { dbWrite, writeTransaction } from "../../db/helpers";
import { lockOrganizationPolicy } from "../../db/repositories/organization-policy-generation";
import { inferenceFundingBudgetGrants } from "../../db/schemas/inference-funding-budgets";
import { CacheTTL } from "../cache/keys";
import { calculateCost, normalizeModelName } from "../pricing";
import { createCreditReservationSettler } from "../utils/credit-reservation";
import { logger } from "../utils/logger";
import type { AffiliateBillingAttribution } from "./affiliate-billing-attribution";
import { AFFILIATE_PAYOUT_CONTRACT_VERSION } from "./affiliate-payout-outbox";
import type { BillingContext, FlatBillingCost } from "./ai-billing";
import {
  getAffiliatePayoutSourceId,
  InsufficientCreditsError,
  reserveCredits,
  reserveFlatUsageCredits,
} from "./ai-billing";
import { AiPricingCacheUnavailableError } from "./ai-pricing/cache";
import { isSubscriptionFundedReservation } from "./allowance-first-credits";
import { billingHoldService } from "./billing-hold";
import {
  BillingHoldActiveError,
  COST_BUFFER,
  type CreditReconciliationResult,
  type CreditReservation,
  creditsService,
  MIN_RESERVATION,
} from "./credits";
import {
  acquireInferenceAdmissionLease,
  createInferenceAdmissionBalanceFence,
  fenceInferenceAdmissionLeaseForSettlement,
  type InferenceAdmissionBalanceObservation,
  InferenceAdmissionGateUnavailableError,
  type InferenceAdmissionLease,
  InferenceAdmissionLeaseRejectedError,
  inferenceSettlementAmounts,
  isInferenceAdmissionPolicyStaleError,
  markInferenceAdmissionLeaseDispatched,
  rebaseStaleInferenceAdmissionLease,
  settleInferenceAdmissionLease,
} from "./inference-admission-gate";
import {
  fillInferenceAdmissionSnapshot,
  getInferenceAdmissionSnapshotCacheFirst,
  peekInferenceAdmissionSnapshot,
  peekInferenceAdmissionSnapshotInIsolate,
  refreshInferenceAdmissionSnapshotOffResponse,
  refreshStaleInferenceAdmissionSnapshot,
} from "./inference-admission-snapshot";
import {
  InferenceAffiliateCacheUnavailableError as AffiliateCacheUnavailableError,
  getCachedInferenceAffiliateAttribution,
} from "./inference-affiliate-cache";
import type { InferenceAdmissionSnapshot } from "./inference-auth-cache";
import { isInferenceAdmissionSnapshot } from "./inference-auth-cache";
import {
  debitInferenceCost,
  InferenceBillingUnavailableError,
} from "./inference-billing-fast-path";
import {
  type InferenceCredentialCheck,
  InferenceCredentialRevokedError,
} from "./inference-credential-revocation";
import { readOrganizationQuotaPolicyInTransaction } from "./organization-quota-policy";
import {
  fundSubscriberInferenceCharge,
  type SubscriberFundingCapacity,
} from "./subscriber-inference-funding";

export type InferenceAdmissionMode =
  | "durable_object_funded_budget"
  | "durable_object_debit"
  | "durable_object_affiliate_debit"
  | "durable_object_subscription_funding"
  | "synchronous_reservation";

export interface OrganizationInferenceAdmission {
  mode: InferenceAdmissionMode;
  settle(actualCostUsd: number): Promise<CreditReconciliationResult | null>;
  /** Conservatively settle provider work whose exact usage is unavailable. */
  settleUnknown(): Promise<CreditReconciliationResult | null>;
  /** Durably record provider acceptance before streamed output is delivered. */
  markProviderDispatched?(): Promise<void>;
  /**
   * Reservation-compatible view for accounting that must reconcile before a
   * payout. Affiliate billing passes this to `billUsage`, which then waits for
   * the same first-call settlement promise before minting earnings.
   */
  reservation?: CreditReservation;
  /** Immutable affiliate policy selected before provider dispatch. */
  affiliateAttribution?: AffiliateBillingAttribution | null;
}

export interface OrganizationInferenceAdmissionParams {
  /** Provider-enforced bounds, distinct from estimates used for unknown-outcome recovery. */
  maximumInputTokens?: number;
  maximumOutputTokens?: number;
  fundedBudgetRateReceipt?: string;
  fundedBudgetEndpointType?: "completions" | "embeddings" | "standard" | "strict";
  context: BillingContext & {
    provider: string;
    billingSource: string;
    requestId: string;
  };
  apiKeyId?: string | null;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  /** Fixed provider-priced operation; skips token-price calculation. */
  flatCost?: FlatBillingCost;
  affiliateCode?: string | null;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  /** Combined auth-cache projection; skips the separate balance KV read. */
  admissionSnapshot?: InferenceAdmissionSnapshot;
  /** Strong standing proof consumed atomically by the primary admission gate. */
  credential?: InferenceCredentialCheck;
  /**
   * Prepare the lease locally and commit it with dispatch at an audited
   * provider boundary. Limited to callers whose dispatch callback is required.
   */
  atomicProviderBoundary?: boolean;
  /** Await primary persistence and gate acknowledgment for funded settlement. */
  requireTerminalSettlementReceipt?: boolean;
}

/** Retryable signal for a configured Worker cache that cannot serve pricing. */
export class InferencePricingCacheUnavailableError extends InferenceBillingUnavailableError {
  constructor(readonly cause: AiPricingCacheUnavailableError) {
    super();
    this.name = "InferencePricingCacheUnavailableError";
  }
}

/** Retryable signal for an affiliate policy cache that cannot serve safely. */
export class InferenceAffiliateCacheUnavailableError extends InferenceBillingUnavailableError {
  constructor(readonly cause: AffiliateCacheUnavailableError) {
    super();
    this.name = "InferenceAffiliateCacheUnavailableError";
  }
}

/** The request cannot safely defer its durable charge in this Worker. */
export class InferenceAdmissionUnavailableError extends ElizaError {
  override readonly name = "InferenceAdmissionUnavailableError";
  readonly statusCode = 503;

  constructor(options?: {
    cause?: unknown;
    context?: Record<string, unknown>;
  }) {
    super("Inference admission transport is unavailable", {
      code: "INFERENCE_ADMISSION_UNAVAILABLE",
      cause: options?.cause,
      context: options?.context,
      severity: "ephemeral",
    });
  }
}

function admissionUnavailable(
  params: OrganizationInferenceAdmissionParams,
  cause?: unknown,
): InferenceAdmissionUnavailableError {
  return new InferenceAdmissionUnavailableError({
    cause,
    context: {
      organizationId: params.context.organizationId,
      userId: params.context.userId,
      requestId: params.context.requestId,
      model: params.context.model,
      provider: params.context.provider,
      billingSource: params.context.billingSource,
    },
  });
}

async function reserveSynchronously(
  params: OrganizationInferenceAdmissionParams,
  subscriptionFunded?: boolean,
): Promise<OrganizationInferenceAdmission> {
  const context = {
    ...params.context,
    affiliateCode: params.affiliateCode ?? undefined,
  };
  const reservation = params.flatCost
    ? await reserveFlatUsageCredits(context, params.flatCost, {
        idempotencyKey: params.context.requestId,
        subscriptionFunded,
      })
    : await reserveCredits(context, params.estimatedInputTokens, params.estimatedOutputTokens, {
        subscriptionFunded,
      });
  const settle = createCreditReservationSettler(reservation);
  return {
    mode: "synchronous_reservation",
    settle,
    settleUnknown: () => settle(reservation.reservedAmount),
    affiliateAttribution: reservation.affiliateAttribution ?? null,
    reservation: {
      reservedAmount: reservation.reservedAmount,
      reservationTransactionId: reservation.reservationTransactionId,
      affiliateAttribution: reservation.affiliateAttribution ?? null,
      affiliatePayoutSourceId: reservation.affiliatePayoutSourceId ?? null,
      // Deferred settlers (pending video) must settle a funded hold through
      // subscription funding, never the purchased-credit reservation ledger.
      ...(isSubscriptionFundedReservation(reservation) ? { funding: reservation.funding } : {}),
      reconcile: async (actualCostUsd) => (await settle(actualCostUsd)) ?? undefined,
    },
  };
}

function attachInferenceAdmissionLease(
  admission: OrganizationInferenceAdmission,
  lease: InferenceAdmissionLease,
  params: OrganizationInferenceAdmissionParams,
  /** Balance observed by the settling transaction; omitted lanes read it after debit. */
  settledBalance?: () => InferenceAdmissionBalanceObservation | undefined,
  /**
   * The balance this lane leases against in a refilled snapshot, or undefined
   * when that snapshot funds the organization through the other lane.
   */
  rebaseOnFreshSnapshot?: (
    fresh: InferenceAdmissionSnapshot,
  ) => { balanceUsd: number; balanceRevision: string } | undefined,
): OrganizationInferenceAdmission {
  const settleAuthoritatively = admission.settle;
  const settleUnknownAuthoritatively = admission.settleUnknown;
  type SettlementChoice = { kind: "actual"; actualCostUsd: number } | { kind: "unknown" };
  let choice: SettlementChoice | undefined;
  let settlement: Promise<CreditReconciliationResult | null> | null = null;
  // error-policy:J2 add request identity and preserve the established
  // transport-facing standing, balance, and availability error types.
  const dispatchRefusal = (error: unknown): unknown => {
    if (error instanceof InferenceCredentialRevokedError) {
      logger.warn(
        "[OrganizationInferenceAdmission] blocked provider dispatch at combined credential and balance gate",
        {
          organizationId: params.context.organizationId,
          userId: params.context.userId,
          requestId: params.context.requestId,
          credentialKind: params.credential?.kind ?? "unavailable",
          reason: error.reason,
        },
      );
      return error;
    }
    if (error instanceof InferenceAdmissionLeaseRejectedError) {
      return new InsufficientCreditsError(
        error.requiredUsd,
        error.availableUsd,
        "cached_balance_gate",
      );
    }
    if (error instanceof InferenceAdmissionGateUnavailableError) {
      return admissionUnavailable(params, error);
    }
    return error;
  };
  let stalePolicyRepairUsed = false;
  const markProviderDispatched = async (): Promise<void> => {
    try {
      await markInferenceAdmissionLeaseDispatched(lease);
      return;
    } catch (error) {
      if (
        !rebaseOnFreshSnapshot ||
        stalePolicyRepairUsed ||
        !isInferenceAdmissionPolicyStaleError(error)
      ) {
        throw dispatchRefusal(error);
      }
      // A deferred commit meets the gate for the first time here, so this is
      // where a snapshot from before a policy change is refused. The gate
      // recorded nothing: refill from the primary, decide again, commit once.
      stalePolicyRepairUsed = true;
      const fresh = await refreshAfterStalePolicy(params);
      if (fresh.billingHold === true) {
        throw new BillingHoldActiveError(params.context.organizationId, "0.000000");
      }
      const observation = rebaseOnFreshSnapshot(fresh);
      if (
        !observation ||
        !rebaseStaleInferenceAdmissionLease(lease, {
          ...observation,
          policyGeneration: fresh.authority.generation,
        })
      ) {
        throw dispatchRefusal(error);
      }
    }
    try {
      await markInferenceAdmissionLeaseDispatched(lease);
    } catch (error) {
      throw dispatchRefusal(error);
    }
  };
  const run = (requestedChoice: SettlementChoice): Promise<CreditReconciliationResult | null> => {
    choice ??= requestedChoice;
    if (settlement) return settlement;
    const selected = choice;
    const current = (async () => {
      if (selected.kind === "actual" && selected.actualCostUsd === 0 && !lease.providerDispatched) {
        let terminalZero = false;
        await settleInferenceAdmissionLease(lease, 0, 0, settledBalance?.(), (receipt) => {
          terminalZero =
            receipt.version === 1 &&
            receipt.organizationId === params.context.organizationId &&
            receipt.requestId === params.context.requestId &&
            (receipt.state === "not_reserved" || receipt.state === "released_zero");
        });
        // A lost/absent release acknowledgement must not turn a resolved void into money proof.
        // The ordinary public wrapper attaches the exact canonical receipt to this explicit result.
        return terminalZero
          ? {
              reservedAmount: 0,
              actualCost: 0,
              collectedAmount: 0,
              settlementTransactionIds: [],
              adjustmentType: "none" as const,
            }
          : null;
      }
      if (selected.kind === "unknown" || selected.actualCostUsd > 0) {
        await markProviderDispatched();
        await fenceInferenceAdmissionLeaseForSettlement(
          lease,
          selected.kind === "actual" ? selected.actualCostUsd : lease.estimatedCostUsd,
        );
      }
      const reconciliation =
        selected.kind === "actual"
          ? await settleAuthoritatively(selected.actualCostUsd)
          : await settleUnknownAuthoritatively();
      const actualCostUsd =
        selected.kind === "actual"
          ? selected.actualCostUsd
          : Math.max(lease.estimatedCostUsd, reconciliation?.actualCost ?? 0);
      const amounts = inferenceSettlementAmounts(lease, actualCostUsd, reconciliation);
      await settleInferenceAdmissionLease(
        lease,
        amounts.balanceBackedUsd,
        amounts.gateConsumedUsd,
        settledBalance?.(),
      );
      return reconciliation;
    })();
    settlement = current;
    current.then(
      () => undefined,
      () => {
        // error-policy:J5 the caller observes the settlement failure. Retrying
        // reuses authoritative idempotency and repairs the still-held lease.
        if (settlement === current) settlement = null;
      },
    );
    return current;
  };
  const settle = (actualCostUsd: number): Promise<CreditReconciliationResult | null> =>
    run({ kind: "actual", actualCostUsd });
  const settleUnknown = (): Promise<CreditReconciliationResult | null> => run({ kind: "unknown" });
  if (admission.reservation) {
    admission.reservation.reconcile = async (actualCostUsd) =>
      (await settle(actualCostUsd)) ?? undefined;
  }
  return {
    ...admission,
    settle,
    settleUnknown,
    markProviderDispatched,
  };
}

/**
 * Admit one organization-credit inference request.
 *
 * Worker requests acquire one exact balance lease before dispatch and perform
 * their deterministic debit after provider work. Valid affiliate attribution
 * selects the atomic debit-plus-payout lane; non-Worker callers keep
 * synchronous reservation compatibility.
 */
export async function admitOrganizationInference(
  params: OrganizationInferenceAdmissionParams,
): Promise<OrganizationInferenceAdmission> {
  try {
    return withCanonicalSettlementReceipt(
      await admitOrganizationInferenceOnce(params),
      params.context,
    );
  } catch (error) {
    if (!(error instanceof InsufficientCreditsError)) throw error;
    const { inferenceBudgetGateRequest, isFundedBudgetAdmissionEnabled } = await import(
      "./inference-funded-budget-admission"
    );
    if (!isFundedBudgetAdmissionEnabled()) throw error;
    // A compatibility caller may have no usable budget snapshot while its
    // funds remain held by delegated inference. Check the primary before 402.
    const hasOpenEscrow = async (): Promise<boolean> => {
      const [grant] = await dbWrite
        .select({ id: inferenceFundingBudgetGrants.id })
        .from(inferenceFundingBudgetGrants)
        .where(
          and(
            eq(inferenceFundingBudgetGrants.organization_id, params.context.organizationId),
            isNull(inferenceFundingBudgetGrants.closed_at),
          ),
        )
        .limit(1);
      return grant !== undefined;
    };
    if (!(await hasOpenEscrow())) throw error;
    const handoff = await inferenceBudgetGateRequest<{
      released?: boolean;
      pending?: boolean;
    }>(params.context.organizationId, "/budget/reclaim", {});
    if (handoff.pending === true) throw admissionUnavailable(params, error);
    if (handoff.released !== true) throw admissionUnavailable(params, error);
    try {
      return withCanonicalSettlementReceipt(
        await admitOrganizationInferenceOnce(params),
        params.context,
      );
    } catch (retryError) {
      if (retryError instanceof InsufficientCreditsError && (await hasOpenEscrow()))
        throw admissionUnavailable(params, retryError);
      throw retryError;
    }
  }
}

async function admitOrganizationInferenceOnce(
  params: OrganizationInferenceAdmissionParams,
): Promise<OrganizationInferenceAdmission> {
  const {
    isFundedBudgetAdmissionEnabled,
    admitFundedBudgetInference,
    InferenceFundingBudgetUnavailableError,
  } = await import("./inference-funded-budget-admission");
  if (
    isFundedBudgetAdmissionEnabled() &&
    params.admissionSnapshot?.fundedBudget?.enabled &&
    params.executionCtx &&
    params.credential?.kind === "api_key" &&
    params.credential.rateLimit !== undefined &&
    params.credential.expiresAt !== undefined &&
    ((params.flatCost && params.flatCost.totalCost > 0) ||
      (Number.isSafeInteger(params.maximumInputTokens) &&
        params.maximumInputTokens! > 0 &&
        Number.isSafeInteger(params.maximumOutputTokens) &&
        params.maximumOutputTokens! > 0))
  ) {
    try {
      return await admitFundedBudgetInference(params);
    } catch (error) {
      if (error instanceof InferenceFundingBudgetUnavailableError)
        throw admissionUnavailable(params, error);
      throw error;
    }
  }
  const executionCtx = params.executionCtx;
  if (typeof executionCtx?.waitUntil === "function") {
    return await admitFromSnapshot(params, await workerAdmissionSnapshot(params));
  }
  return await admitWithoutGate(params);
}

/**
 * Hosts without a Worker lifetime have no organization Durable Object to fence
 * a deferred charge, so they reserve against the primary before dispatch. This
 * is the only remaining Postgres admission, and no Worker route reaches it.
 */
async function admitWithoutGate(
  params: OrganizationInferenceAdmissionParams,
): Promise<OrganizationInferenceAdmission> {
  const policy = await writeTransaction(async (tx) => {
    await lockOrganizationPolicy(tx, params.context.organizationId);
    const current = await readOrganizationQuotaPolicyInTransaction(
      tx,
      params.context.organizationId,
    );
    await billingHoldService.assertNoHold(params.context.organizationId, tx);
    return current;
  });
  return await reserveSynchronously(params, policy.subscriptionFunded);
}

/**
 * A refusal decided from a snapshot older than this refreshes the snapshot
 * from the primary after the response. It matches the isolate projection
 * lifetime, so an organization that stays refused costs at most one primary
 * read per isolate in this window, while a top-up or hold release missed by
 * the cached snapshot is honored by the requests that can read that refresh
 * (see `admitFromSnapshot` for the bound).
 */
const REFUSAL_REFILL_MIN_AGE_MS = 5_000;

/**
 * The snapshot a Worker request is admitted from. A snapshot carried by the
 * combined auth decision (or the isolate's newer copy of it) decides the
 * request at any age; one older than the shared projection lifetime is
 * refreshed under `waitUntil` for later requests. The organization gate keeps
 * the committed balance and the policy-generation fence, so an aged snapshot
 * cannot overspend or dispatch under a superseded policy. Only a request with
 * no snapshot reads the shared cache and, when that is cold too, the primary.
 * A carried snapshot that would refuse for a billing hold is the one decision
 * the gate cannot correct, and the auth entry keeps carrying it until its own
 * refresh; such a request reads the published projection and uses it when it
 * is newer, so the refill scheduled by one refusal serves every isolate.
 * A snapshot that cannot prove hold standing or subscriber funding is not a
 * usable decision and is filled from the primary once.
 */
async function workerAdmissionSnapshot(
  params: OrganizationInferenceAdmissionParams,
): Promise<InferenceAdmissionSnapshot> {
  const organizationId = params.context.organizationId;
  const carried = params.admissionSnapshot;
  let snapshot: InferenceAdmissionSnapshot;
  if (isInferenceAdmissionSnapshot(carried)) {
    const local = peekInferenceAdmissionSnapshotInIsolate(organizationId);
    snapshot = local && local.balance.balanceAt > carried.balance.balanceAt ? local : carried;
    if (snapshot.billingHold === true) {
      const published = await peekInferenceAdmissionSnapshot(organizationId);
      if (published && published.balance.balanceAt > snapshot.balance.balanceAt) {
        snapshot = published;
      }
    }
  } else {
    snapshot = await getInferenceAdmissionSnapshotCacheFirst(organizationId);
  }
  if (!snapshotIsComplete(snapshot)) {
    snapshot = await fillInferenceAdmissionSnapshot(organizationId);
    if (!snapshotIsComplete(snapshot)) throw admissionUnavailable(params);
    return snapshot;
  }
  if (params.executionCtx && snapshotAgeMs(snapshot) > CacheTTL.inference.orgAdmission * 1000) {
    refreshInferenceAdmissionSnapshotOffResponse(organizationId, params.executionCtx);
  }
  return snapshot;
}

function snapshotAgeMs(snapshot: InferenceAdmissionSnapshot): number {
  return Date.now() - snapshot.balance.balanceAt;
}

function snapshotIsComplete(snapshot: InferenceAdmissionSnapshot): boolean {
  return (
    typeof snapshot.billingHold === "boolean" &&
    (!snapshot.subscriptionFunded ||
      snapshot.funding?.balanceRevision === snapshot.balance.balanceRevision)
  );
}

/**
 * Admit from the published snapshot. The only pre-dispatch round trip is the
 * organization Durable Object lease and dispatch, and the gate decides
 * affordability: every committed balance change is published to it (see
 * `republishInferenceAdmissionAfterCreditMutation`) and it keeps the newest
 * balance revision, so a lease carrying an older snapshot is charged against
 * the committed balance. The gate also refuses a snapshot whose policy
 * generation was superseded or while a policy/hold mutation is open (see the
 * standing fence in `inference-policy-fence.ts`); that refusal refills the
 * projection inline and retries once, at the lease for an immediate commit
 * and at the provider boundary for a deferred one (see
 * `attachInferenceAdmissionLease`). A balance or hold refusal decided from
 * an aged snapshot stands for this request and refreshes the projection under
 * `waitUntil`. Later requests are admitted once they can read that refill:
 * the same isolate at once, other isolates after the shared cache propagates
 * it. Refusals from a stale hold can therefore repeat while the refill is in
 * flight or propagating, and once more if the shared entry expires
 * (`CacheTTL.inference.orgAdmission`) before the auth entry is rewritten. A
 * hold carried by a snapshot younger than `REFUSAL_REFILL_MIN_AGE_MS` schedules
 * no refill, so its refusals last until the snapshot reaches that age.
 */
async function admitFromSnapshot(
  params: OrganizationInferenceAdmissionParams,
  snapshot: InferenceAdmissionSnapshot,
): Promise<OrganizationInferenceAdmission> {
  const admitOnce = (current: InferenceAdmissionSnapshot) => {
    if (current.billingHold === true) {
      throw new BillingHoldActiveError(params.context.organizationId, "0.000000");
    }
    const policyGeneration = current.authority.generation;
    return current.subscriptionFunded && current.funding
      ? admitSubscriberViaDurableObject(params, current.funding, policyGeneration)
      : admitCreditsViaDurableObject(params, {
          balanceUsd: current.balance.balanceUsd,
          balanceRevision: current.balance.balanceRevision,
          policyGeneration,
        });
  };
  try {
    return await admitOnce(snapshot);
  } catch (error) {
    if (isStalePolicyRefusal(error)) {
      return await admitOnce(await refreshAfterStalePolicy(params));
    }
    if (!isStandingRefusal(error) || snapshotAgeMs(snapshot) < REFUSAL_REFILL_MIN_AGE_MS) {
      throw error;
    }
    if (params.executionCtx) {
      refreshInferenceAdmissionSnapshotOffResponse(
        params.context.organizationId,
        params.executionCtx,
        { force: true },
      );
    }
    throw error;
  }
}

function isStandingRefusal(error: unknown): boolean {
  return error instanceof InsufficientCreditsError || error instanceof BillingHoldActiveError;
}

function isStalePolicyRefusal(error: unknown): boolean {
  return (
    error instanceof InferenceAdmissionUnavailableError &&
    isInferenceAdmissionPolicyStaleError(error.cause)
  );
}

async function refreshAfterStalePolicy(
  params: OrganizationInferenceAdmissionParams,
): Promise<InferenceAdmissionSnapshot> {
  try {
    await refreshStaleInferenceAdmissionSnapshot(params.context.organizationId);
    const snapshot = await getInferenceAdmissionSnapshotCacheFirst(params.context.organizationId);
    if (!snapshotIsComplete(snapshot)) throw admissionUnavailable(params);
    return snapshot;
  } catch (error) {
    if (error instanceof InferenceAdmissionUnavailableError) throw error;
    // error-policy:J2 an open policy mutation keeps the gate closed; report
    // the retryable admission refusal with its cause.
    throw admissionUnavailable(params, error);
  }
}

/**
 * Lease subscriber funding capacity in the organization Durable Object and
 * fund the exact charge allowance-first after the provider responds.
 */
async function admitSubscriberViaDurableObject(
  params: OrganizationInferenceAdmissionParams,
  capacity: SubscriberFundingCapacity,
  policyGeneration: string,
): Promise<OrganizationInferenceAdmission> {
  const executionCtx = params.executionCtx;
  if (!executionCtx) throw admissionUnavailable(params);
  const affiliateMarked = Boolean(params.affiliateCode?.trim());
  let estimatedCostUsd: number;
  let affiliateAttribution: AffiliateBillingAttribution | null;
  try {
    const [cost, attribution] = await Promise.all([
      params.flatCost
        ? Promise.resolve(params.flatCost)
        : calculateCost(
            normalizeModelName(params.context.model),
            params.context.provider,
            params.estimatedInputTokens,
            params.estimatedOutputTokens,
            params.context.billingSource,
            { cacheOnly: true, executionCtx },
          ),
      affiliateMarked
        ? getCachedInferenceAffiliateAttribution({
            affiliateCode: params.affiliateCode,
            organizationId: params.context.organizationId,
            userId: params.context.userId,
            executionCtx,
          })
        : null,
    ]);
    affiliateAttribution = attribution;
    // Same sizing as the synchronous subscriber reservation: the affiliate
    // markup is part of the charge, and a token estimate carries the buffer.
    const markedUpEstimate = cost.totalCost * (1 + (affiliateAttribution?.markupPercent ?? 0));
    estimatedCostUsd =
      affiliateAttribution && !params.flatCost ? markedUpEstimate * COST_BUFFER : markedUpEstimate;
  } catch (error) {
    throw classifyCacheError(error);
  }
  const affiliatePayoutSourceId = affiliateAttribution
    ? getAffiliatePayoutSourceId(params.context)
    : null;
  const affiliatePayout =
    affiliateAttribution && affiliatePayoutSourceId
      ? { attribution: affiliateAttribution, sourceId: affiliatePayoutSourceId }
      : undefined;
  const requiredLeaseUsd = Math.max(estimatedCostUsd, MIN_RESERVATION);
  let lease: InferenceAdmissionLease;
  try {
    lease = await acquireInferenceAdmissionLease({
      organizationId: params.context.organizationId,
      requestId: params.context.requestId,
      balanceUsd: capacity.balanceUsd,
      balanceRevision: capacity.balanceRevision,
      balanceView: "funding",
      estimatedCostUsd: requiredLeaseUsd,
      recovery: {
        version: 1,
        kind: "organization",
        organizationId: params.context.organizationId,
        requestId: params.context.requestId,
        userId: params.context.userId,
        model: params.context.model,
        provider: params.context.provider,
        billingSource: params.context.billingSource,
        description: params.context.description ?? `Inference request: ${params.context.model}`,
        ...(params.context.metadata && { metadata: params.context.metadata }),
        accounting: affiliatePayout
          ? {
              kind: "subscription_funding",
              affiliate: {
                attribution: affiliatePayout.attribution,
                payoutSourceId: affiliatePayout.sourceId,
              },
            }
          : { kind: "subscription_funding" },
      },
      credential: params.credential,
      executionCtx,
      deferCommitUntilDispatch: params.atomicProviderBoundary === true,
      policyGeneration,
    });
  } catch (error) {
    throw classifyLeaseError(params, error);
  }
  // Until funding runs, the admission observation is the newest capacity this
  // request knows; equal-revision gate updates can only lower the ceiling.
  let settledBalance: InferenceAdmissionBalanceObservation = {
    balanceUsd: capacity.balanceUsd,
    balanceRevision: capacity.balanceRevision,
    balanceView: "funding",
  };
  const settle = async (actualCostUsd: number): Promise<CreditReconciliationResult> => {
    if (actualCostUsd <= 0) {
      return {
        reservedAmount: 0,
        actualCost: 0,
        settlementTransactionIds: [],
        adjustmentType: "none",
      };
    }
    const funded = await fundSubscriberInferenceCharge({
      organizationId: params.context.organizationId,
      requestId: params.context.requestId,
      userId: params.context.userId,
      model: params.context.model,
      provider: params.context.provider,
      billingSource: params.context.billingSource,
      description: params.context.description ?? `Inference request: ${params.context.model}`,
      metadata: params.context.metadata,
      amountUsd: actualCostUsd,
      ...(affiliatePayout && { affiliatePayout }),
    });
    settledBalance = {
      balanceUsd: funded.capacity.balanceUsd,
      balanceRevision: funded.capacity.balanceRevision,
      balanceView: "funding",
    };
    return funded.reconciliation;
  };
  return attachInferenceAdmissionLease(
    {
      mode: "durable_object_subscription_funding",
      settle,
      settleUnknown: () => settle(requiredLeaseUsd),
      reservation: {
        reservedAmount: requiredLeaseUsd,
        reservationTransactionId: null,
        affiliateAttribution,
        affiliatePayoutSourceId,
        reconcile: settle,
      },
      affiliateAttribution,
    },
    lease,
    params,
    () => settledBalance,
    (fresh) => {
      if (!fresh.subscriptionFunded || !fresh.funding) return undefined;
      settledBalance = {
        balanceUsd: fresh.funding.balanceUsd,
        balanceRevision: fresh.funding.balanceRevision,
        balanceView: "funding",
      };
      return settledBalance;
    },
  );
}

/** Credit balance observation a credit-funded Worker admission leases against. */
interface CreditBalanceObservation {
  balanceUsd: number;
  balanceRevision: string;
  policyGeneration: string;
}

/**
 * Lease a credit-funded request in the organization Durable Object and debit
 * the exact charge (plus any pinned affiliate payout) after the provider.
 */
async function admitCreditsViaDurableObject(
  params: OrganizationInferenceAdmissionParams,
  observation: CreditBalanceObservation,
): Promise<OrganizationInferenceAdmission> {
  const executionCtx = params.executionCtx;
  if (!executionCtx) throw admissionUnavailable(params);
  const affiliateMarked = Boolean(params.affiliateCode?.trim());
  const normalizedModel = normalizeModelName(params.context.model);
  let estimatedCostUsd: number;
  let affiliateAttribution: AffiliateBillingAttribution | null = null;
  try {
    const [cost, resolvedAffiliateAttribution] = await Promise.all([
      params.flatCost
        ? Promise.resolve(params.flatCost)
        : calculateCost(
            normalizedModel,
            params.context.provider,
            params.estimatedInputTokens,
            params.estimatedOutputTokens,
            params.context.billingSource,
            { cacheOnly: true, executionCtx },
          ),
      affiliateMarked
        ? getCachedInferenceAffiliateAttribution({
            affiliateCode: params.affiliateCode,
            organizationId: params.context.organizationId,
            userId: params.context.userId,
            executionCtx,
          })
        : null,
    ]);
    affiliateAttribution = resolvedAffiliateAttribution;
    const affiliateMarkupPercent = affiliateAttribution?.markupPercent ?? 0;
    const markedUpEstimate = cost.totalCost * (1 + affiliateMarkupPercent);
    estimatedCostUsd =
      affiliateMarked && !params.flatCost
        ? Math.max(markedUpEstimate * COST_BUFFER, MIN_RESERVATION)
        : markedUpEstimate;
  } catch (error) {
    throw classifyCacheError(error);
  }

  // The Durable Object serializes every in-flight estimate, so no balance
  // cushion applies here: an affordable request is admitted at any balance.
  const requiredLeaseUsd = Math.max(estimatedCostUsd, MIN_RESERVATION);

  let inferenceLease: InferenceAdmissionLease;
  try {
    inferenceLease = await acquireInferenceAdmissionLease({
      organizationId: params.context.organizationId,
      requestId: params.context.requestId,
      balanceUsd: observation.balanceUsd,
      balanceRevision: observation.balanceRevision,
      estimatedCostUsd: requiredLeaseUsd,
      recovery: {
        version: 1,
        kind: "organization",
        organizationId: params.context.organizationId,
        requestId: params.context.requestId,
        userId: params.context.userId,
        model: params.context.model,
        provider: params.context.provider,
        billingSource: params.context.billingSource,
        description: params.context.description ?? `Inference request: ${params.context.model}`,
        ...(params.context.metadata && {
          metadata: params.context.metadata,
        }),
        accounting: affiliateAttribution
          ? {
              kind: "affiliate_debit",
              attribution: affiliateAttribution,
              payoutSourceId: getAffiliatePayoutSourceId(params.context),
            }
          : { kind: "direct_debit" },
      },
      credential: params.credential,
      executionCtx,
      deferCommitUntilDispatch: params.atomicProviderBoundary === true,
      policyGeneration: observation.policyGeneration,
    });
  } catch (error) {
    throw classifyLeaseError(params, error);
  }

  const debit = {
    requestId: params.context.requestId,
    organizationId: params.context.organizationId,
    userId: params.context.userId,
    model: params.context.model,
    provider: params.context.provider,
    billingSource: params.context.billingSource,
  };
  const inferenceBalanceFence = createInferenceAdmissionBalanceFence(inferenceLease);
  if (affiliateAttribution) {
    const affiliatePayoutSourceId = getAffiliatePayoutSourceId(params.context);
    const reservationMetadata = {
      ...(params.context.metadata ?? {}),
      affiliatePayout: {
        version: AFFILIATE_PAYOUT_CONTRACT_VERSION,
        sourceId: affiliatePayoutSourceId,
        attribution: affiliateAttribution,
        model: params.context.model,
      },
    };
    const settle = (actualCostUsd: number) =>
      creditsService.collectAffiliateInferenceFallback({
        organizationId: debit.organizationId,
        userId: debit.userId,
        requestId: debit.requestId,
        model: debit.model,
        provider: debit.provider,
        billingSource: debit.billingSource,
        actualCost: actualCostUsd,
        reservationMetadata,
        // The attached lease remains active until the affiliate debit,
        // lower-only handoff, authoritative republish, and gate settlement
        // all finish.
        preserveInferenceBalanceHint: true,
        inferenceBalanceFence,
      });
    const result: OrganizationInferenceAdmission = {
      mode: "durable_object_affiliate_debit",
      settle,
      settleUnknown: () => settle(estimatedCostUsd),
      reservation: {
        reservedAmount: estimatedCostUsd,
        reservationTransactionId: null,
        affiliateAttribution,
        affiliatePayoutSourceId,
        reconcile: settle,
      },
      affiliateAttribution,
    };
    return attachInferenceAdmissionLease(
      result,
      inferenceLease,
      params,
      undefined,
      creditBalanceInFreshSnapshot,
    );
  }

  // A zero-cost outcome can settle against the admission observation. The
  // gate ignores older revisions and cannot raise an equal-revision ceiling.
  // Paid outcomes replace this with the balance returned by the debit itself.
  let settledBalance: InferenceAdmissionBalanceObservation = {
    balanceUsd: observation.balanceUsd,
    balanceRevision: observation.balanceRevision,
  };
  const settle = async (actualCostUsd: number): Promise<CreditReconciliationResult> => {
    if (actualCostUsd <= 0) {
      return {
        reservedAmount: 0,
        actualCost: 0,
        settlementTransactionIds: [],
        adjustmentType: "none",
      };
    }
    const outcome = await debitInferenceCost(debit, actualCostUsd, "deferred", {
      // The attached admission lease remains active until this authoritative
      // debit and gate settlement finish, so the last valid projection can
      // stay present during the post-stream republish handoff.
      preserveBalanceHintDuringFencedHandoff: true,
      inferenceBalanceFence,
    });
    settledBalance = {
      balanceUsd: outcome.newBalanceUsd,
      balanceRevision: outcome.balanceRevision,
    };
    return {
      reservedAmount: outcome.collectedAmountUsd,
      actualCost: actualCostUsd,
      collectedAmount: outcome.collectedAmountUsd,
      settlementTransactionIds: outcome.transactionId ? [outcome.transactionId] : [],
      adjustmentType:
        outcome.status === "collected" && outcome.collectedAmountUsd + 0.000001 >= actualCostUsd
          ? "none"
          : "uncollected_overage",
    };
  };
  return attachInferenceAdmissionLease(
    {
      mode: "durable_object_debit",
      settle,
      settleUnknown: () => settle(estimatedCostUsd),
      reservation: {
        reservedAmount: estimatedCostUsd,
        reservationTransactionId: null,
        affiliateAttribution: null,
        affiliatePayoutSourceId: null,
        reconcile: settle,
      },
      affiliateAttribution: null,
    },
    inferenceLease,
    params,
    () => settledBalance,
    (fresh) => {
      const balance = creditBalanceInFreshSnapshot(fresh);
      if (balance) settledBalance = balance;
      return balance;
    },
  );
}

/** The credit balance of a refilled snapshot, unless it now funds through a subscription. */
function creditBalanceInFreshSnapshot(
  fresh: InferenceAdmissionSnapshot,
): { balanceUsd: number; balanceRevision: string } | undefined {
  if (fresh.subscriptionFunded && fresh.funding) return undefined;
  return {
    balanceUsd: fresh.balance.balanceUsd,
    balanceRevision: fresh.balance.balanceRevision,
  };
}

/** Map pricing/affiliate policy failures to retryable admission errors. */
function classifyCacheError(error: unknown): unknown {
  if (error instanceof AiPricingCacheUnavailableError)
    return new InferencePricingCacheUnavailableError(error);
  if (error instanceof AffiliateCacheUnavailableError)
    return new InferenceAffiliateCacheUnavailableError(error);
  return error;
}

/** Preserve typed gate refusals; wrap transport failures as admission unavailability. */
function classifyLeaseError(params: OrganizationInferenceAdmissionParams, error: unknown): unknown {
  if (error instanceof InferenceCredentialRevokedError) {
    // error-policy:J2 preserve the typed combined-gate refusal after
    // attaching the full admission identity needed for diagnostics.
    logger.warn(
      "[OrganizationInferenceAdmission] blocked provider dispatch at combined credential and balance gate",
      {
        organizationId: params.context.organizationId,
        userId: params.context.userId,
        requestId: params.context.requestId,
        credentialKind: params.credential?.kind ?? "unavailable",
        reason: error.reason,
      },
    );
    return error;
  }
  if (error instanceof InferenceAdmissionLeaseRejectedError) {
    return new InsufficientCreditsError(
      error.requiredUsd,
      error.availableUsd,
      "cached_balance_gate",
    );
  }
  if (error instanceof InferenceAdmissionGateUnavailableError) {
    // error-policy:J2 preserve the gate transport failure for route-level
    // classification and diagnostics.
    return admissionUnavailable(params, error);
  }
  return error;
}
