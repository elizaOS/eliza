/** Private allocation calculation. Publication still needs the original live receipt lease and locks. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type { readOriginalInvoiceCommercialSelection } from "../../db/repositories/subscription-invoice-commercial-selection";
import type { observeOriginalInvoiceDebt } from "./observed-invoice-debt";
import { traceOriginalInvoiceDebt } from "./original-invoice-debt-trace";
import { settlementDigest } from "./settlement-digest";
import { validateInvoiceCapture } from "./stripe-invoice-capture";
import { resolveSubscriptionPlanDefinition } from "./subscription-catalog";
import {
  bindSubscriptionInvoiceEventEvidence,
  type SubscriptionInvoiceEventEvidence,
} from "./subscription-invoice-event-evidence";

type Selection = Awaited<ReturnType<typeof readOriginalInvoiceCommercialSelection>>;
type Observation = Awaited<ReturnType<typeof observeOriginalInvoiceDebt>>;
const uuid = z.string().uuid();
function unavailable(reason: string): never {
  throw new ElizaError("Original invoice funding allocation is unavailable", {
    code: "SUBSCRIPTION_INVOICE_FUNDING_PLAN_UNAVAILABLE",
    context: { reason },
  });
}
function equal(a: unknown, b: unknown) {
  if (a === undefined || b === undefined) return a === b;
  return settlementDigest(a) === settlementDigest(b);
}
function digest(value: { digest: string }) {
  const { digest: expected, ...body } = value;
  if (!/^[a-f0-9]{64}$/.test(expected) || settlementDigest(body) !== expected)
    unavailable("evidence_digest_mismatch");
}

/** Inputs must be read from authenticated receipt/journal ownership and receipt-derived selection.
 * Hashes detect mismatched records, not authenticity or provider freshness. This function performs
 * no I/O and does not authorize spending, apply a lifecycle revision, or publish financial effects.
 * Full collection preserves the existing catalog recurring allowance and original expiry; this
 * policy does not decide how a subsequent refund or credit note affects that allowance. */
export function planOriginalInvoiceFunding(input: {
  collector: SubscriptionInvoiceEventEvidence;
  originals: readonly SubscriptionInvoiceEventEvidence[];
  observation: Observation;
  selections: readonly Selection[];
}) {
  const collector = bindSubscriptionInvoiceEventEvidence(input.collector, input.collector.scope);
  const originals = input.originals.map((row) =>
    bindSubscriptionInvoiceEventEvidence(row, row.scope),
  );
  const originalsByInvoice = new Map(originals.map((row) => [row.scope.invoiceId, row]));
  const originalsByDigest = new Map([collector, ...originals].map((row) => [row.digest, row]));
  const observation = input.observation;
  digest(observation);
  digest(observation.capture);
  digest(observation.capture.balance);
  if (
    observation.capture.kind !== "retained_collecting_invoice_capture" ||
    observation.capture.version !== 1 ||
    observation.capture.balance.kind !== "retained_invoice_balance_observation" ||
    observation.capture.balance.version !== 1
  )
    unavailable("unsupported_observation_version");
  for (const nested of [observation.capture, observation.capture.balance]) {
    for (const key of [
      "organizationId",
      "subscriptionId",
      "providerAccountId",
      "customerId",
      "invoiceId",
      "livemode",
      "currency",
      "originalEvidenceDigest",
    ] as const)
      if (nested[key] !== observation[key]) unavailable("nested_observation_owner_mismatch");
  }

  if (
    observation.kind !== "observed_original_invoice_debt" ||
    observation.version !== 1 ||
    observation.originalEvidenceDigest !== collector.digest ||
    observation.collectorOriginalEvidenceDigest !== collector.digest ||
    observation.organizationId !== collector.scope.organizationId ||
    observation.subscriptionId !== collector.scope.subscriptionId ||
    observation.invoiceId !== collector.scope.invoiceId ||
    observation.providerAccountId !== collector.scope.providerAccountId ||
    observation.customerId !== collector.scope.customerId ||
    observation.livemode !== collector.scope.livemode ||
    observation.currency !== "usd" ||
    !equal(observation.capture.balance.invoice, collector.event.data.object)
  )
    unavailable("collecting_observation_mismatch");
  const capture = validateInvoiceCapture({
    invoice: collector.event.data.object,
    paymentIntent: observation.capture.payment,
    charge: observation.capture.charge,
  });
  const trace = traceOriginalInvoiceDebt({
    collector,
    originals,
    history: observation.capture.balance.history,
  });
  if (!equal(trace, observation.trace)) unavailable("debt_trace_mismatch");
  const expected = new Map(trace.components.map((component) => [component.invoiceId, component]));
  if (
    observation.originals.length !== expected.size ||
    new Set(observation.originals.map((row) => row.invoiceId)).size !== expected.size
  )
    unavailable("current_original_set_mismatch");
  for (const current of observation.originals) {
    const component = expected.get(current.invoiceId);
    const original = originalsByInvoice.get(current.invoiceId);
    if (
      !component ||
      !original ||
      !equal(current.invoice, original.event.data.object) ||
      !equal(current.originalEvidenceDigests, component.originalEvidenceDigests)
    )
      unavailable("current_original_mismatch");
  }
  const required = new Set([collector.scope.invoiceId, ...expected.keys()]);
  if (input.selections.length !== required.size) unavailable("commercial_selection_set_mismatch");
  const receipts = new Set<string>();
  const periods = new Set<string>();
  const owners = new Map<string, string>();
  const allocations = input.selections
    .map((selection) => {
      digest(selection);
      const scope = selection.scope;
      if (
        selection.kind !== "original_invoice_commercial_selection" ||
        selection.version !== 1 ||
        !uuid.safeParse(selection.receiptId).success ||
        receipts.has(selection.receiptId) ||
        !required.delete(scope.invoiceId) ||
        selection.organizationId !== collector.scope.organizationId ||
        scope.organizationId !== collector.scope.organizationId ||
        scope.providerAccountId !== collector.scope.providerAccountId ||
        scope.customerId !== collector.scope.customerId ||
        scope.livemode !== collector.scope.livemode ||
        (selection.fence !== null && selection.fence.state !== "open")
      )
        unavailable("commercial_selection_owner_mismatch");
      receipts.add(selection.receiptId);
      const original = originalsByDigest.get(selection.originalEvidenceDigest);
      if (!original || !equal(scope, original.scope)) unavailable("commercial_original_mismatch");
      const component = expected.get(scope.invoiceId);
      if (scope.invoiceId === collector.scope.invoiceId && original.digest !== collector.digest)
        unavailable("collector_original_substitution");
      if (component && !component.originalEvidenceDigests.includes(original.digest))
        unavailable("commercial_original_not_traced");
      const invoice = original.event.data.object,
        line = invoice.lines.data[0]!;
      const terms = selection.terms;
      const plan = resolveSubscriptionPlanDefinition(terms.planKey, terms.catalogVersion);
      if (
        terms.baseAmountCents !== plan.amountCents ||
        terms.allowanceAmountUsd !== plan.allowance.amountUsd ||
        terms.currency !== plan.currency ||
        terms.baseAmountCents !== line.amount ||
        terms.priceId !== line.price.id ||
        terms.productId !== line.price.product ||
        terms.subscriptionItemId !== line.subscription_item ||
        terms.periodStart !== line.period.start ||
        terms.periodEnd !== line.period.end ||
        !selection.origins.length
      )
        unavailable("commercial_terms_mismatch");
      if (
        new Set(selection.origins.map((origin) => origin.commandId)).size !==
        selection.origins.length
      )
        unavailable("duplicate_commercial_origin");
      for (const origin of selection.origins) {
        digest(origin);
        if (
          origin.kind !== "original_invoice_commercial_origin" ||
          origin.version !== 1 ||
          !["checkout", "upgrade", "downgrade"].includes(origin.originKind) ||
          !uuid.safeParse(origin.commandId).success ||
          !/^[a-f0-9]{64}$/.test(origin.checkoutContractDigest) ||
          !/^[a-f0-9]{64}$/.test(origin.originDigest) ||
          !Number.isSafeInteger(origin.effectiveAt) ||
          origin.effectiveAt < 0 ||
          origin.effectiveAt > terms.periodStart ||
          origin.effectiveAt > original.event.created ||
          origin.originalEvidenceDigest !== original.digest ||
          !equal(origin.scope, scope) ||
          Object.entries(terms).some(
            ([key, value]) => !equal(value, origin[key as keyof typeof origin]),
          )
        )
          unavailable("commercial_origins_disagree");
      }
      // Local subscription ids are not unique for one Stripe subscription item.
      // Key both maps on that provider identity so a second local id cannot
      // fund the same item or the same billing interval.
      const providerIdentity = `${scope.providerSubscriptionId}:${terms.subscriptionItemId}`;
      if (
        (owners.get(scope.subscriptionId) ?? providerIdentity) !== providerIdentity ||
        (owners.get(providerIdentity) ?? scope.subscriptionId) !== scope.subscriptionId
      )
        unavailable("subscription_identity_conflict");
      owners.set(scope.subscriptionId, providerIdentity);
      owners.set(providerIdentity, scope.subscriptionId);
      const periodKey = `${providerIdentity}:${terms.periodStart}:${terms.periodEnd}`;
      if (periods.has(periodKey)) unavailable("duplicate_original_period");
      periods.add(periodKey);
      return {
        invoiceId: scope.invoiceId,
        subscriptionId: scope.subscriptionId,
        originalReceiptId: selection.receiptId,
        originalEvidenceDigest: original.digest,
        commercialSelectionDigest: selection.digest,
        commercialOriginDigests: selection.origins.map((origin) => origin.digest).sort(),
        role:
          scope.invoiceId === collector.scope.invoiceId
            ? ("collector" as const)
            : ("deferred" as const),
        collectedAmountCents: invoice.total,
        currency: invoice.currency,
        planKey: terms.planKey,
        catalogVersion: terms.catalogVersion,
        allowanceAmountUsd: plan.allowance.amountUsd,
        periodStart: terms.periodStart,
        periodEnd: terms.periodEnd,
        expiresAt: terms.periodEnd,
      };
    })
    .sort((a, b) => (a.invoiceId < b.invoiceId ? -1 : a.invoiceId > b.invoiceId ? 1 : 0));
  if (
    required.size ||
    allocations.reduce((sum, row) => sum + BigInt(row.collectedAmountCents), 0n) !==
      BigInt(capture.payment.amount_received)
  )
    unavailable("collection_conservation_mismatch");
  const body = {
    kind: "original_invoice_funding_plan" as const,
    version: 1 as const,
    policyVersion: "full_original_recurring_allowance_v1" as const,
    organizationId: collector.scope.organizationId,
    providerAccountId: collector.scope.providerAccountId,
    customerId: collector.scope.customerId,
    livemode: collector.scope.livemode,
    collectorInvoiceId: collector.scope.invoiceId,
    collectorOriginalEvidenceDigest: collector.digest,
    observationDigest: observation.digest,
    traceDigest: trace.digest,
    captureDigest: observation.capture.digest,
    collectedAmountCents: capture.payment.amount_received,
    currency: "usd" as const,
    allocations,
  };
  return { ...body, digest: settlementDigest(body) };
}
