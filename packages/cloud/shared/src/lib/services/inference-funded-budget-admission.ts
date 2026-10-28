/** Admission authority delegated to the existing organization Durable Object. */
import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { sqlRows } from "../../db/execute-helpers";
import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";
import { bindCloudBindings, getCloudAwareEnv, getCloudBinding } from "../runtime/cloud-bindings";
import type { InferenceFundingBudgetConsumption } from "./inference-funding-budget-protocol";
import type { OrganizationQuotaPolicy } from "./organization-quota-policy";
import { requireOrganizationRateTier } from "./organization-quota-policy";

export interface InferenceBudgetPolicy {
  organizationId: string;
  enabled: boolean;
  epoch: string;
  policyGeneration: string;
  validUntil: number;
  rateLimits: {
    completionsRpm: number;
    embeddingsRpm: number;
    standardRpm: number;
    strictRpm: number;
  };
}

export class InferenceFundingBudgetUnavailableError extends ElizaError {
  readonly statusCode = 503;
  constructor(message: string, cause?: unknown) {
    super(message, { code: "INFERENCE_FUNDING_BUDGET_UNAVAILABLE", severity: "ephemeral", cause });
  }
}

export function isInferenceBudgetPolicy(value: unknown): value is InferenceBudgetPolicy {
  if (value === null || typeof value !== "object") return false;
  const p = value as Partial<InferenceBudgetPolicy>;
  return (
    typeof p.organizationId === "string" &&
    p.organizationId.length > 0 &&
    typeof p.enabled === "boolean" &&
    typeof p.epoch === "string" &&
    /^(0|[1-9]\d*)$/.test(p.epoch) &&
    typeof p.policyGeneration === "string" &&
    /^(0|[1-9]\d*)$/.test(p.policyGeneration) &&
    Number.isSafeInteger(p.validUntil) &&
    (p.validUntil ?? 0) > 0 &&
    p.rateLimits !== undefined &&
    p.rateLimits !== null &&
    typeof p.rateLimits === "object" &&
    [
      p.rateLimits.completionsRpm,
      p.rateLimits.embeddingsRpm,
      p.rateLimits.standardRpm,
      p.rateLimits.strictRpm,
    ].every((rate) => Number.isSafeInteger(rate) && rate > 0)
  );
}

export function isFundedBudgetAdmissionEnabled(): boolean {
  const env = getCloudAwareEnv();
  return (
    env.INFERENCE_FUNDED_BUDGET_ADMISSION === "true" &&
    env.INFERENCE_STRONG_REVOCATION_ENABLED === "true"
  );
}

/** Called only by primary hydration or policy publication, never by a warm request. */
export async function readInferenceBudgetPolicy(
  tx: DbTransaction,
  organizationId: string,
  policy: OrganizationQuotaPolicy,
): Promise<InferenceBudgetPolicy | undefined> {
  if (!isFundedBudgetAdmissionEnabled()) return undefined;
  const [row] = await sqlRows<{ epoch: string }>(
    tx,
    sql`
    SELECT epoch::text FROM inference_policy_authorities
    WHERE organization_id = ${organizationId} AND enabled = true
  `,
  );
  if (!row) return undefined;
  const tier = requireOrganizationRateTier(policy);
  // The effective policy deadline is authority, independent of cache freshness.
  const validUntil =
    policy.authority.effectiveUntil === null
      ? Number.MAX_SAFE_INTEGER
      : Date.parse(policy.authority.effectiveUntil);
  if (!Number.isSafeInteger(validUntil))
    throw new InferenceFundingBudgetUnavailableError(
      "Delegated inference policy deadline is invalid",
    );
  const { billingHoldService } = await import("./billing-hold");
  const hold = await billingHoldService.getState(organizationId, tx);
  return {
    organizationId,
    enabled: policy.subscriptionFunded && hold.status !== "held" && validUntil > Date.now(),
    epoch: row.epoch,
    policyGeneration: policy.authority.generation,
    validUntil,
    rateLimits: {
      completionsRpm: tier.completionsRpm,
      embeddingsRpm: tier.embeddingsRpm,
      standardRpm: tier.standardRpm,
      strictRpm: tier.strictRpm,
    },
  };
}

export async function loadInferenceBudgetPolicy(
  organizationId: string,
): Promise<InferenceBudgetPolicy> {
  const { writeTransaction } = await import("../../db/helpers");
  const { lockOrganizationPolicyForRead } = await import(
    "../../db/repositories/organization-policy-generation"
  );
  return writeTransaction(async (tx) => {
    await lockOrganizationPolicyForRead(tx, organizationId);
    const [standing] = await sqlRows<{
      enabled: boolean | null;
      epoch: string | null;
      generation: string | null;
      is_active: boolean;
      account_lifecycle_state: string;
      account_deletion_request_id: string | null;
      paid_work_fenced_at: Date | null;
    }>(
      tx,
      sql`
      SELECT f.enabled, f.epoch::text, a.policy_generation::text AS generation,
        o.is_active, o.account_lifecycle_state, o.account_deletion_request_id, o.paid_work_fenced_at
      FROM organizations o
      LEFT JOIN inference_policy_authorities f ON f.organization_id = o.id
      LEFT JOIN organization_subscription_authorities a ON a.organization_id = o.id
      WHERE o.id = ${organizationId}
    `,
    );
    if (!standing || standing.generation === null || (standing.enabled && standing.epoch === null))
      throw new InferenceFundingBudgetUnavailableError(
        "Delegated inference authority is unavailable",
      );
    if (
      !standing.enabled ||
      !standing.is_active ||
      standing.account_lifecycle_state !== "active" ||
      standing.account_deletion_request_id !== null ||
      standing.paid_work_fenced_at !== null ||
      !isFundedBudgetAdmissionEnabled()
    ) {
      // Publish an explicit prohibition even when the disabled account can no
      // longer resolve a serving subscription. These rates grant no admission.
      const { resolveOrgTierFromSourceValues } = await import("./org-rate-limits");
      const tier = resolveOrgTierFromSourceValues(organizationId, 0).tierData;
      return {
        organizationId,
        enabled: false,
        epoch: standing.epoch ?? "0",
        policyGeneration: standing.generation,
        validUntil: Number.MAX_SAFE_INTEGER,
        rateLimits: {
          completionsRpm: tier.completionsRpm,
          embeddingsRpm: tier.embeddingsRpm,
          standardRpm: tier.standardRpm,
          strictRpm: tier.strictRpm,
        },
      };
    }
    const { readOrganizationQuotaPolicyInTransaction } = await import(
      "./organization-quota-policy"
    );
    const policy = await readOrganizationQuotaPolicyInTransaction(tx, organizationId);
    const result = await readInferenceBudgetPolicy(tx, organizationId, policy);
    if (!result)
      throw new InferenceFundingBudgetUnavailableError("Delegated inference is not enrolled");
    return result;
  });
}

export async function inferenceBudgetGateRequest<T>(
  organizationId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const namespace = getCloudBinding<RuntimeDurableObjectNamespace>("INFERENCE_ADMISSION_GATES");
  if (!namespace)
    throw new InferenceFundingBudgetUnavailableError("Inference admission binding is unavailable");
  let response: Response;
  try {
    response = await namespace.getByName(organizationId).fetch(
      new Request(`https://inference-admission.internal${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, organizationId }),
      }),
    );
  } catch (cause) {
    throw new InferenceFundingBudgetUnavailableError(
      "Inference budget acknowledgement is unknown",
      cause,
    );
  }
  const result: unknown = await response.json();
  if (!response.ok) {
    if (response.status === 402 && result !== null && typeof result === "object") {
      const refusal = result as { requiredMicros?: unknown; availableMicros?: unknown };
      if (
        typeof refusal.requiredMicros === "string" &&
        typeof refusal.availableMicros === "string" &&
        /^\d+$/.test(refusal.requiredMicros) &&
        /^\d+$/.test(refusal.availableMicros)
      ) {
        const { InsufficientCreditsError } = await import("./credits");
        throw new InsufficientCreditsError(
          Number(refusal.requiredMicros) / 1e6,
          Number(refusal.availableMicros) / 1e6,
          "primary_budget_refill",
        );
      }
    }
    if (response.status === 403) {
      const { InferenceCredentialRevokedError } = await import("./inference-credential-revocation");
      throw new InferenceCredentialRevokedError("credential_revoked");
    }
    if (response.status === 429) {
      const { RateLimitError } = await import("../api/errors");
      throw new RateLimitError("Organization inference rate limit exceeded");
    }
    throw new InferenceFundingBudgetUnavailableError(
      `Inference budget refused with status ${response.status}`,
    );
  }
  if (result === null || typeof result !== "object")
    throw new InferenceFundingBudgetUnavailableError("Inference budget response is invalid");
  return result as T;
}

/** Uses a caller-proven upper bound; a refill target never caps a request. */
export async function admitFundedBudgetInference(
  params: import("./organization-inference-admission").OrganizationInferenceAdmissionParams,
): Promise<import("./organization-inference-admission").OrganizationInferenceAdmission> {
  const policy = params.admissionSnapshot?.fundedBudget;
  const credential = params.credential;
  if (
    !policy?.enabled ||
    !isInferenceBudgetPolicy(policy) ||
    !params.executionCtx ||
    policy.organizationId !== params.context.organizationId ||
    credential?.kind !== "api_key" ||
    !Number.isSafeInteger(credential.rateLimit) ||
    credential.rateLimit! <= 0 ||
    credential.expiresAt === undefined
  )
    throw new InferenceFundingBudgetUnavailableError("Funded admission proof is incomplete");
  const { calculateCost, normalizeModelName } = await import("../pricing");
  const { getCachedInferenceAffiliateAttribution } = await import("./inference-affiliate-cache");
  const affiliate = params.affiliateCode?.trim()
    ? await getCachedInferenceAffiliateAttribution({
        affiliateCode: params.affiliateCode,
        organizationId: params.context.organizationId,
        userId: params.context.userId,
        executionCtx: params.executionCtx,
      })
    : null;
  const cache = { cacheOnly: true, executionCtx: params.executionCtx };
  const { canonicalFundingAmount } = await import("./allowance-first-credits");
  const [maximum, estimate] = await Promise.all([
    params.flatCost ??
      calculateCost(
        normalizeModelName(params.context.model),
        params.context.provider,
        params.maximumInputTokens!,
        params.maximumOutputTokens!,
        params.context.billingSource,
        cache,
      ),
    params.flatCost ??
      calculateCost(
        normalizeModelName(params.context.model),
        params.context.provider,
        params.estimatedInputTokens,
        params.estimatedOutputTokens,
        params.context.billingSource,
        cache,
      ),
  ]);
  const markedMicros = (amount: number) =>
    new Decimal(amount)
      .mul(1 + (affiliate?.markupPercent ?? 0))
      .mul(1e6)
      .ceil();
  const maximumMicros = markedMicros(maximum.totalCost);
  const { COST_BUFFER } = await import("./credits");
  const unknownMicros = Decimal.min(
    maximumMicros,
    markedMicros(estimate.totalCost * (affiliate && !params.flatCost ? COST_BUFFER : 1)),
  );
  if (
    !maximumMicros.isFinite() ||
    !maximumMicros.isPositive() ||
    !unknownMicros.isFinite() ||
    unknownMicros.isNegative()
  )
    throw new InferenceFundingBudgetUnavailableError("Funded request upper bound is invalid");
  const { getAffiliatePayoutSourceId } = await import("./ai-billing");
  const { AFFILIATE_PAYOUT_CONTRACT_VERSION } = await import("./affiliate-payout-outbox");
  const metadata: Record<string, unknown> = {
    ...params.context.metadata,
    requestId: params.context.requestId,
    userId: params.context.userId,
    model: params.context.model,
    provider: params.context.provider,
    billingSource: params.context.billingSource,
    ...(affiliate && {
      affiliatePayout: {
        version: AFFILIATE_PAYOUT_CONTRACT_VERSION,
        sourceId: getAffiliatePayoutSourceId(params.context),
        attribution: affiliate,
        model: params.context.model,
      },
    }),
  };
  const createdAt = Date.now();
  const preProviderCancellationToken = crypto.randomUUID();
  const payload = {
    organizationId: params.context.organizationId,
    requestId: params.context.requestId,
    maximumMicros: maximumMicros.toFixed(0),
    unknownCostMicros: unknownMicros.toFixed(0),
    policyEpoch: policy.epoch,
    policyGeneration: policy.policyGeneration,
    credential,
    endpointType: params.fundedBudgetEndpointType ?? "completions",
    rateReceipt: params.fundedBudgetRateReceipt,
    createdAt,
    expiresAt: createdAt + 20 * 60_000,
    preProviderCancellationToken,
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
      metadata,
      accounting: { kind: "subscription_funding" },
    },
  };
  let dispatched = false;
  let dispatch: Promise<void> | undefined;
  const markProviderDispatched = bindCloudBindings((): Promise<void> => {
    if (dispatched) return Promise.resolve();
    return (dispatch ??= (async () => {
      const result = await inferenceBudgetGateRequest<{ admitted?: boolean }>(
        policy.organizationId,
        "/budget/admit",
        payload,
      );
      if (result.admitted !== true)
        throw new InferenceFundingBudgetUnavailableError("Funded dispatch was not acknowledged");
      dispatched = true;
    })().catch(async (error) => {
      // No provider call follows an unknown admission acknowledgement. The capability
      // permits only this pre-provider caller to release its ambiguous reservation.
      try {
        await inferenceBudgetGateRequest(policy.organizationId, "/budget/cancel", {
          requestId: params.context.requestId,
          preProviderCancellationToken,
        });
      } catch (cancelError) {
        const { logger } = await import("../utils/logger");
        logger.error("[InferenceBudget] admission cancellation requires recovery", {
          requestId: params.context.requestId,
          error: cancelError instanceof Error ? cancelError.message : String(cancelError),
        });
      }
      dispatch = undefined;
      throw error;
    }));
  });
  let settlement: Promise<import("./credits").CreditReconciliationResult> | undefined;
  let settlementAmount: string | undefined;
  const settle = bindCloudBindings((actualCostUsd: number) => {
    const amount = new Decimal(canonicalFundingAmount(actualCostUsd)).mul(1e6);
    if (!amount.isFinite() || amount.isNegative() || amount.gt(maximumMicros))
      throw new InferenceFundingBudgetUnavailableError(
        "Actual charge exceeds its funded request bound",
      );
    if (settlementAmount !== undefined && settlementAmount !== amount.toFixed(0))
      throw new InferenceFundingBudgetUnavailableError(
        "Funded settlement replay changed its charge",
      );
    settlementAmount = amount.toFixed(0);
    return (settlement ??= (async () => {
      if (amount.gt(0)) await markProviderDispatched();
      if (dispatched) {
        const result = await inferenceBudgetGateRequest<{
          receipt: InferenceFundingBudgetConsumption;
        }>(policy.organizationId, "/budget/complete", {
          requestId: params.context.requestId,
          amountMicros: amount.toFixed(0),
        });
        if (
          !result.receipt ||
          result.receipt.organizationId !== policy.organizationId ||
          result.receipt.requestId !== params.context.requestId ||
          result.receipt.amountMicros !== amount.toFixed(0)
        )
          throw new InferenceFundingBudgetUnavailableError(
            "Funded settlement receipt does not match its request",
          );
        params.executionCtx!.waitUntil(persistInferenceBudgetConsumption(result.receipt));
      }
      return {
        reservedAmount: maximumMicros.div(1e6).toNumber(),
        actualCost: actualCostUsd,
        collectedAmount: amount.div(1e6).toNumber(),
        settlementTransactionIds: [],
        adjustmentType: "none" as const,
      };
    })().catch((error) => {
      settlement = undefined;
      throw error;
    }));
  });
  return {
    mode: "durable_object_funded_budget",
    affiliateAttribution: affiliate,
    markProviderDispatched,
    settle,
    // An unknown acknowledgement can already have committed the chosen actual
    // charge. Retry that identity; choose the estimate only before any attempt.
    settleUnknown: () =>
      settle(new Decimal(settlementAmount ?? unknownMicros.toFixed(0)).div(1e6).toNumber()),
    reservation: {
      reservedAmount: maximumMicros.div(1e6).toNumber(),
      reservationTransactionId: null,
      affiliateAttribution: affiliate,
      affiliatePayoutSourceId: affiliate ? getAffiliatePayoutSourceId(params.context) : null,
      reconcile: settle,
    },
  };
}

/** Durable receipt acknowledgement happens only after the primary commit succeeds. */
export async function persistInferenceBudgetConsumption(
  receipt: InferenceFundingBudgetConsumption,
): Promise<void> {
  const { recordConsumption } = await import("../../db/repositories/inference-funding-budgets");
  await recordConsumption(receipt);
  await inferenceBudgetGateRequest(receipt.organizationId, "/budget/acknowledge", { receipt });
}
