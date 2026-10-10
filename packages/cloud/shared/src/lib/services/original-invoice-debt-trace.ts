/** Pure debit provenance trace; not provider freshness, capture, allocation policy or grant authority. */
import { ElizaError } from "@elizaos/core";
import { settlementDigest } from "./settlement-digest";
import { proveInvoiceAdjustments } from "./stripe-invoice-adjustments";
import { invoiceBalanceHistorySchema } from "./stripe-invoice-settlement";
import {
  bindSubscriptionInvoiceEventEvidence,
  type SubscriptionInvoiceEventEvidence,
} from "./subscription-invoice-event-evidence";

function unavailable(reason: string): never {
  throw new ElizaError("Original invoice debt provenance is unavailable", {
    code: "SUBSCRIPTION_INVOICE_DEBT_TRACE_UNAVAILABLE",
    context: { reason },
  });
}
/** Originals must come from authenticated receipt-owned retention, never later provider reads.
 * Supports complete full-debit carry-forward chains. Unknown adjustments, partial transfers and
 * reversed/ambiguous movements fail explicitly. Caller must separately qualify provider shapes,
 * reobserve current originals/capture and recheck all owners before any financial publication. */
export function traceOriginalInvoiceDebt(input: {
  collector: SubscriptionInvoiceEventEvidence;
  originals: readonly SubscriptionInvoiceEventEvidence[];
  history: unknown;
}) {
  const collector = bindSubscriptionInvoiceEventEvidence(input.collector, input.collector.scope);
  const owner = collector.scope;
  const originalByInvoice = new Map<string, SubscriptionInvoiceEventEvidence>();
  const digestsByInvoice = new Map<string, Set<string>>();
  for (const value of [collector, ...input.originals]) {
    const original = bindSubscriptionInvoiceEventEvidence(value, value.scope);
    const scope = original.scope;
    if (
      scope.organizationId !== owner.organizationId ||
      scope.providerAccountId !== owner.providerAccountId ||
      scope.customerId !== owner.customerId ||
      scope.livemode !== owner.livemode
    )
      unavailable("foreign_original_owner");
    const previous = originalByInvoice.get(scope.invoiceId);
    if (
      previous &&
      (previous.scope.subscriptionId !== scope.subscriptionId ||
        settlementDigest(previous.event.data.object) !==
          settlementDigest(original.event.data.object))
    )
      unavailable("conflicting_original_invoice");
    originalByInvoice.set(scope.invoiceId, original);
    const digests = digestsByInvoice.get(scope.invoiceId) ?? new Set<string>();
    digests.add(original.digest);
    digestsByInvoice.set(scope.invoiceId, digests);
  }
  const parsed = invoiceBalanceHistorySchema.safeParse(input.history);
  if (!parsed.success || parsed.data.has_more || parsed.data.data.length > 10_000)
    unavailable("complete_bounded_history_required");
  const rows = parsed.data.data;
  const seenRows = new Set<string>();
  const positions = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!,
      older = rows[i + 1];
    if (
      seenRows.has(row.id) ||
      row.customer !== owner.customerId ||
      row.livemode !== owner.livemode ||
      row.currency !== "usd"
    )
      unavailable("foreign_or_duplicate_movement");
    seenRows.add(row.id);
    if (
      older &&
      (row.created < older.created ||
        BigInt(row.ending_balance) - BigInt(row.amount) !== BigInt(older.ending_balance))
    )
      unavailable("ledger_discontinuity");
    if (row.invoice) positions.set(row.invoice, [...(positions.get(row.invoice) ?? []), i]);
  }
  function invoice(id: string) {
    const original = originalByInvoice.get(id);
    if (!original) unavailable("missing_original_invoice");
    const value = original.event.data.object;
    if (
      value.pre_payment_credit_notes_amount ||
      value.post_payment_credit_notes_amount ||
      value.starting_balance < 0
    )
      unavailable("adjusted_original_invoice");
    proveInvoiceAdjustments(value, value.lines.data[0]);
    return { original, value };
  }
  const target = invoice(owner.invoiceId).value;
  if (
    target.starting_balance <= 0 ||
    target.ending_balance !== 0 ||
    BigInt(target.total) + BigInt(target.starting_balance) !== BigInt(target.amount_due) ||
    target.amount_paid !== target.amount_due ||
    !target.payment_intent ||
    !target.charge
  )
    unavailable("unsupported_collecting_invoice");
  const links = positions.get(target.id);
  if (!links || links.length !== 1) unavailable("ambiguous_collector_movements");
  let applicationIndex = links[0]!;
  let current = target;
  const visited = new Set<string>([target.id]);
  const transfers: Array<{
    invoiceId: string;
    applicationId: string;
    debitPostingId: string;
    debitInvoiceId: string;
    amount: number;
  }> = [];
  const components: Array<{
    invoiceId: string;
    subscriptionId: string;
    providerSubscriptionId: string;
    period: { start: number; end: number };
    amount: number;
    originalEvidenceDigests: string[];
  }> = [];
  while (true) {
    const application = rows[applicationIndex];
    if (
      !application ||
      application.invoice !== current.id ||
      application.type !== "applied_to_invoice" ||
      application.credit_note !== null ||
      application.amount !== -current.starting_balance ||
      application.ending_balance !== 0 ||
      application.created > current.status_transitions.paid_at
    )
      unavailable("unsupported_debit_application");
    const postingIndex = applicationIndex + 1;
    const posting = rows[postingIndex];
    if (
      !posting ||
      !posting.invoice ||
      !["invoice_too_small", "invoice_too_large"].includes(posting.type) ||
      posting.credit_note !== null ||
      posting.amount !== current.starting_balance ||
      posting.ending_balance !== posting.amount ||
      visited.has(posting.invoice)
    )
      unavailable("unsupported_debt_origin");
    visited.add(posting.invoice);
    const { original, value: deferred } = invoice(posting.invoice);
    if (
      deferred.amount_due !== 0 ||
      deferred.amount_paid !== 0 ||
      deferred.payment_intent !== null ||
      deferred.charge !== null ||
      deferred.ending_balance !== posting.amount ||
      BigInt(deferred.total) + BigInt(deferred.starting_balance) !== BigInt(posting.amount) ||
      posting.created > deferred.status_transitions.paid_at ||
      deferred.status_transitions.paid_at > current.status_transitions.paid_at
    )
      unavailable("deferred_original_arithmetic_mismatch");
    const deferredLinks = positions.get(deferred.id)!;
    if (
      deferredLinks.length !== (deferred.starting_balance > 0 ? 2 : 1) ||
      deferredLinks[0] !== postingIndex ||
      (deferred.starting_balance > 0 && deferredLinks[1] !== postingIndex + 1)
    )
      unavailable("ambiguous_deferred_movements");
    components.push({
      invoiceId: deferred.id,
      subscriptionId: original.scope.subscriptionId,
      providerSubscriptionId: original.scope.providerSubscriptionId,
      period: { ...deferred.lines.data[0]!.period },
      amount: deferred.total,
      originalEvidenceDigests: [...digestsByInvoice.get(deferred.id)!].sort(),
    });
    transfers.push({
      invoiceId: current.id,
      applicationId: application.id,
      debitPostingId: posting.id,
      debitInvoiceId: deferred.id,
      amount: posting.amount,
    });
    if (deferred.starting_balance === 0) break;
    current = deferred;
    applicationIndex = postingIndex + 1;
  }
  if (
    components.reduce((sum, component) => sum + BigInt(component.amount), 0n) !==
    BigInt(target.starting_balance)
  )
    unavailable("debt_conservation_mismatch");
  const body = {
    kind: "original_invoice_debt_trace" as const,
    version: 1 as const,
    organizationId: owner.organizationId,
    providerAccountId: owner.providerAccountId,
    customerId: owner.customerId,
    livemode: owner.livemode,
    currency: target.currency,
    collectorInvoiceId: target.id,
    collectorOriginalEvidenceDigest: collector.digest,
    historyDigest: settlementDigest(parsed.data),
    carriedDebit: target.starting_balance,
    collectorInvoiceTotal: target.total,
    expectedAmountDue: target.amount_due,
    components: components.reverse(),
    transfers: transfers.reverse(),
  };
  return { ...body, digest: settlementDigest(body) };
}
