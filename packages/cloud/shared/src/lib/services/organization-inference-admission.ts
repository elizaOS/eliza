import { withCanonicalSettlementReceipt } from "./inference-settlement-receipt";
/**
 * Admission for organization-funded inference.
 *
 * Worker requests are admitted from the cached organization admission
 * snapshot alone: no billing hold, and subscriber capacity or credit that
 * covers the request's estimate. That snapshot arrives with the request's
 * single auth-cache read, so an admitted request makes no Durable Object call
 * and no Postgres read before provider dispatch.
 *
 * A snapshot that would refuse is not trusted: the published projection and
 * then the primary are read inline before the refusal is returned, so a
 * top-up, grant, new subscription or released hold is honoured by the first
 * request after it commits. A refusal is off the hot path.
 *
 * Accounting runs after the response under `waitUntil`: the organization
 * Durable Object lease is committed, the deterministic debit or funding
 * identity is written, and the lease is settled. A debit the balance cannot
 * cover collects the balance that is left. When that accounting shows the
 * organization can no longer fund a request (zero capacity, a refused lease,
 * a billing hold), the projection and the request's cached auth entry are
 * refreshed from the primary so the next request is refused.
 *
 * The cached decision is eventually consistent by design. A revoked key, a
 * new hold or an exhausted allowance keeps admitting until the rewritten
 * entry is readable (shared-cache propagation), and spend can exceed the
 * balance by the requests in flight during that window.
 *
 * A request route records nothing durable before its provider call: the lease
 * is first committed by the post-response task. If the isolate dies between
 * the provider call and that commit (a CPU or memory limit, an eviction, the
 * `waitUntil` cap), no lease, debit or recovery record exists and that
 * request's provider cost is not charged. This is the accepted price of one
 * store call before the provider. Once the lease is committed the gate alarm
 * recovers an unsettled charge, and an operation that outlives its request
 * (video, the speech relay) commits at dispatch (`commitLeaseAtDispatch`).
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
import { getRequestInferenceAuthEntryRefresh } from "../runtime/request-context";
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
  /** Strong standing proof for the funded-budget lane; the snapshot lane ignores it. */
  credential?: InferenceCredentialCheck;
  /** Read by app-funded admission only; organization admission always defers its lease. */
  atomicProviderBoundary?: boolean;
  /**
   * Rewrites the request's cached auth entry from the primary, off the
   * response (`InferenceAuthResolution.refreshEntry`). Admission and
   * settlement call it when the entry's funding standing is no longer true.
   * Defaults to the refresh the request's authentication registered.
   */
  refreshAuthEntry?: () => void;
  /**
   * Commit the gate lease when the caller marks provider dispatch, instead of
   * after the response. For long-lived sessions (the speech relay) whose
   * settlement may never run; request routes leave it unset.
   */
  commitLeaseAtDispatch?: boolean;
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
  // The lease is committed after the response, as the first settlement step.
  const commitLease = async (): Promise<void> => {
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
      // The provider has already been invoked, so the charge is owed whatever
      // the gate answers. A refused or unreachable lease skips the gate steps
      // and the deterministic debit below still runs.
      let leaseCommitted = false;
      let standingRefused = false;
      if (selected.kind === "unknown" || selected.actualCostUsd > 0) {
        try {
          await commitLease();
          await fenceInferenceAdmissionLeaseForSettlement(
            lease,
            selected.kind === "actual" ? selected.actualCostUsd : lease.estimatedCostUsd,
          );
          leaseCommitted = true;
        } catch (error) {
          standingRefused = isStandingRefusal(error);
          logger.warn(
            "[OrganizationInferenceAdmission] post-response lease was not committed; debiting without it",
            {
              organizationId: params.context.organizationId,
              requestId: params.context.requestId,
              standingRefused,
              errorName: error instanceof Error ? error.name : "UnknownError",
            },
          );
        }
      } else if (lease.providerDispatched) {
        // Committed at dispatch (`commitLeaseAtDispatch`) and settled at zero:
        // the gate still holds the lease and must release it.
        leaseCommitted = true;
      }
      let reconciliation: CreditReconciliationResult | null;
      try {
        reconciliation =
          selected.kind === "actual"
            ? await settleAuthoritatively(selected.actualCostUsd)
            : await settleUnknownAuthoritatively();
      } catch (error) {
        // The debit may have committed before the step that failed (its
        // balance fence or republish), so the cached standing is unproven:
        // read it again from the primary whatever went wrong.
        refreshStandingOffResponse(params);
        throw error;
      }
      // Decided from the debit itself, before the gate step below can fail.
      const remaining = settledBalance?.();
      const cannotFundNext =
        standingRefused ||
        reconciliation?.adjustmentType === "uncollected_overage" ||
        (remaining !== undefined && !(remaining.balanceUsd > 0));
      if (cannotFundNext) refreshStandingOffResponse(params);
      if (leaseCommitted) {
        const actualCostUsd =
          selected.kind === "actual"
            ? selected.actualCostUsd
            : Math.max(lease.estimatedCostUsd, reconciliation?.actualCost ?? 0);
        const amounts = inferenceSettlementAmounts(lease, actualCostUsd, reconciliation);
        try {
          await settleInferenceAdmissionLease(
            lease,
            amounts.balanceBackedUsd,
            amounts.gateConsumedUsd,
            remaining,
          );
        } catch (error) {
          // The gate did not take the settled balance, so its projection of
          // this organization is stale too.
          if (!cannotFundNext) refreshStandingOffResponse(params);
          throw error;
        }
      }
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
    // Request routes mark the provider boundary and await nothing there. A
    // long-lived session commits its lease here instead, so the gate alarm
    // still recovers the charge if the session dies before it settles.
    markProviderDispatched: params.commitLeaseAtDispatch ? commitLease : () => Promise.resolve(),
  };
}

/**
 * Settlement found the organization unable to fund another request. Refill
 * the projection from the primary and rewrite this request's cached auth
 * entry, both off the response, so the next request is refused from its own
 * cache read.
 */
function refreshStandingOffResponse(params: OrganizationInferenceAdmissionParams): void {
  if (params.executionCtx) {
    refreshInferenceAdmissionSnapshotOffResponse(
      params.context.organizationId,
      params.executionCtx,
      { force: true },
    );
  }
  params.refreshAuthEntry?.();
}

/**
 * Admit one organization-credit inference request.
 *
 * Worker requests are decided from the cached snapshot and perform their
 * lease and deterministic debit after provider work. Valid affiliate
 * attribution selects the atomic debit-plus-payout lane; non-Worker callers
 * keep synchronous reservation compatibility.
 */
export async function admitOrganizationInference(
  input: OrganizationInferenceAdmissionParams,
): Promise<OrganizationInferenceAdmission> {
  // Settlement can run where the request's async context is gone (a stream's
  // pull or cancel), so the entry refresh is bound to the admission here.
  const params: OrganizationInferenceAdmissionParams = {
    ...input,
    refreshAuthEntry: input.refreshAuthEntry ?? getRequestInferenceAuthEntryRefresh(),
  };
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
    // Only a session that commits at dispatch may take the funded-budget
    // lane; a request route never calls the gate before its provider.
    params.commitLeaseAtDispatch === true &&
    isFundedBudgetAdmissionEnabled() &&
    params.admissionSnapshot?.fundedBudget?.enabled &&
    params.executionCtx &&
    params.credential?.kind === "api_key" &&
    params.credential.rateLimit !== undefined &&
    params.credential.expiresAt !== undefined &&
    params.flatCost !== undefined &&
    params.flatCost.totalCost > 0
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
 * A refusing snapshot younger than this was just read from the primary (an
 * isolate refill, a republished projection or a rewritten auth entry), so it
 * is not refilled again. It bounds a refused organization to one primary
 * snapshot fill per isolate in this window; a payment that commits inside the
 * window is honoured when it ends.
 */
const REFUSAL_REFILL_MIN_AGE_MS = 1_000;

/**
 * How long one isolate waits before asking again for the same rewrite of the
 * same credential's entry. A rewrite takes shared-cache propagation time to
 * become readable, and the entry's own aged refresh repeats a lost one.
 */
const ENTRY_REWRITE_REPEAT_MS = 10_000;
const ENTRY_REWRITE_MAX_TRACKED = 2_048;
const requestedEntryRewrites = new Map<string, { standing: string; at: number }>();

/** Test hook: forget which entry rewrites this isolate already requested. */
export function __clearRequestedInferenceEntryRewrites(): void {
  requestedEntryRewrites.clear();
}

/** The snapshot facts that decide funding; snapshots equal in them decide alike. */
function fundingStanding(snapshot: InferenceAdmissionSnapshot): string {
  return JSON.stringify([
    snapshot.billingHold,
    snapshot.subscriptionFunded,
    snapshot.balance.balanceRevision,
    snapshot.balance.balanceUsd,
    snapshot.funding?.balanceRevision ?? null,
    snapshot.funding?.balanceUsd ?? null,
    snapshot.authority.generation,
    snapshot.authority.effectiveUntil,
  ]);
}

/**
 * Rewrite the request's cached auth entry when a newer snapshot decided the
 * request differently from the facts the entry carries. An entry that
 * already carries the newer standing is left alone, and one isolate asks for
 * the same rewrite once per `ENTRY_REWRITE_REPEAT_MS`: a client retrying a
 * refusal in a loop starts no authoritative key hydration per request.
 */
function rewriteDisagreeingAuthEntry(
  params: OrganizationInferenceAdmissionParams,
  decided: InferenceAdmissionSnapshot,
): void {
  if (!params.refreshAuthEntry) return;
  const standing = fundingStanding(decided);
  const carried = params.admissionSnapshot;
  if (isInferenceAdmissionSnapshot(carried) && fundingStanding(carried) === standing) return;
  const credential = `${params.context.organizationId}:${params.apiKeyId ?? params.context.userId}`;
  const now = Date.now();
  const requested = requestedEntryRewrites.get(credential);
  if (requested?.standing === standing && now - requested.at < ENTRY_REWRITE_REPEAT_MS) return;
  if (requestedEntryRewrites.size >= ENTRY_REWRITE_MAX_TRACKED) requestedEntryRewrites.clear();
  requestedEntryRewrites.set(credential, { standing, at: now });
  params.refreshAuthEntry();
}

/**
 * The snapshot a Worker request is first decided from: the one carried by the
 * combined auth decision, or the isolate's newer copy of it. It decides an
 * admitted request at any age with no store call; one older than the shared
 * projection lifetime is refreshed under `waitUntil` for later requests. Only
 * a request with no snapshot reads the shared cache and, when that is cold
 * too, the primary. A snapshot that cannot prove hold standing or subscriber
 * funding is not a usable decision and is filled from the primary once.
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

/** The plan period the snapshot's allowance belongs to has already ended. */
function allowancePeriodEnded(snapshot: InferenceAdmissionSnapshot): boolean {
  const until = snapshot.authority.effectiveUntil;
  return Boolean(until) && Date.parse(until as string) <= Date.now();
}

/** The plan period ended after the snapshot was read, so its allowance may have rolled over. */
function allowancePeriodEndedSince(snapshot: InferenceAdmissionSnapshot): boolean {
  const until = snapshot.authority.effectiveUntil;
  if (!until) return false;
  const endedAt = Date.parse(until);
  return endedAt <= Date.now() && endedAt >= snapshot.balance.balanceAt;
}

/**
 * Admit from the cached snapshot. An admitted request makes no store call:
 * the snapshot must show no billing hold and enough subscriber capacity or
 * credit for the request's estimate, and the lease is only prepared.
 *
 * A snapshot that would refuse is not trusted. A top-up, a redeemed grant, a
 * new subscription, a period rollover or a released hold changes the primary
 * without rewriting the cached auth entry, so the refusal is decided again:
 * first from the published projection when that is newer (one cache read),
 * then from an inline primary fill (coalesced per isolate). A refusal is off
 * the hot path, so those reads cost an admitted request nothing. Whenever the
 * carried entry disagreed with the newer state, it is rewritten off the
 * response (`rewriteDisagreeingAuthEntry`); an entry that already refuses for
 * the same facts is not.
 */
async function admitFromSnapshot(
  params: OrganizationInferenceAdmissionParams,
  snapshot: InferenceAdmissionSnapshot,
): Promise<OrganizationInferenceAdmission> {
  const organizationId = params.context.organizationId;
  const admitOnce = (current: InferenceAdmissionSnapshot) => {
    if (current.billingHold === true) {
      throw new BillingHoldActiveError(organizationId, "0.000000");
    }
    const policyGeneration = current.authority.generation;
    return current.subscriptionFunded && current.funding
      ? admitSubscriberViaDurableObject(
          params,
          current.funding,
          policyGeneration,
          allowancePeriodEnded(current) ? null : current.authority.effectiveUntil,
        )
      : admitCreditsViaDurableObject(params, {
          balanceUsd: current.balance.balanceUsd,
          balanceRevision: current.balance.balanceRevision,
          policyGeneration,
        });
  };
  let refusal: unknown;
  try {
    return await admitOnce(snapshot);
  } catch (error) {
    if (!isStandingRefusal(error)) throw error;
    refusal = error;
  }
  // A refusal just read from the primary stands with no further read. A
  // carried entry it superseded still decides other isolates from older
  // facts, so that entry is rewritten.
  const refusalIsCurrent = (decided: InferenceAdmissionSnapshot) =>
    snapshotAgeMs(decided) < REFUSAL_REFILL_MIN_AGE_MS && !allowancePeriodEndedSince(decided);
  if (refusalIsCurrent(snapshot)) {
    rewriteDisagreeingAuthEntry(params, snapshot);
    throw refusal;
  }
  const published = await peekInferenceAdmissionSnapshot(organizationId);
  if (
    published &&
    snapshotIsComplete(published) &&
    published.balance.balanceAt > snapshot.balance.balanceAt
  ) {
    try {
      const admitted = await admitOnce(published);
      rewriteDisagreeingAuthEntry(params, published);
      return admitted;
    } catch (error) {
      if (!isStandingRefusal(error)) throw error;
      refusal = error;
    }
    if (refusalIsCurrent(published)) {
      rewriteDisagreeingAuthEntry(params, published);
      throw refusal;
    }
  }
  let fresh: InferenceAdmissionSnapshot;
  try {
    fresh = await fillInferenceAdmissionSnapshot(organizationId);
  } catch (fillError) {
    // error-policy:J4 the cached refusal stands when the primary cannot be
    // read; the next refused request tries the fill again.
    logger.warn("[OrganizationInferenceAdmission] refusal refill failed", {
      organizationId,
      error: fillError instanceof Error ? fillError.message : String(fillError),
    });
    throw refusal;
  }
  if (!snapshotIsComplete(fresh)) throw admissionUnavailable(params);
  rewriteDisagreeingAuthEntry(params, fresh);
  return await admitOnce(fresh);
}

/** A plan subscriber has too little allowance and credit left for this request. */
export class AllowanceExhaustedError extends InsufficientCreditsError {
  constructor(
    required: number,
    available: number,
    /** End of the current plan period, when the snapshot names one still ahead. */
    readonly resetsAt: string | null,
  ) {
    super(required, available, "cached_admission_snapshot");
    this.name = "AllowanceExhaustedError";
  }
}

function isStandingRefusal(error: unknown): boolean {
  return error instanceof InsufficientCreditsError || error instanceof BillingHoldActiveError;
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
  resetsAt: string | null,
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
  // The estimate is the pre-provider affordability check; nothing is leased yet.
  if (capacity.balanceUsd < requiredLeaseUsd) {
    throw new AllowanceExhaustedError(requiredLeaseUsd, capacity.balanceUsd, resetsAt);
  }
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
      executionCtx,
      deferCommitUntilDispatch: true,
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

  // The estimate is the pre-provider affordability check; nothing is leased
  // yet, so requests in flight are not counted against each other.
  const requiredLeaseUsd = Math.max(estimatedCostUsd, MIN_RESERVATION);
  if (observation.balanceUsd < requiredLeaseUsd) {
    throw new InsufficientCreditsError(
      requiredLeaseUsd,
      observation.balanceUsd,
      "cached_admission_snapshot",
    );
  }

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
      executionCtx,
      deferCommitUntilDispatch: true,
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
