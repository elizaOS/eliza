/** Read-only original invoice and complete customer-ledger observation; never collection/allocation proof. */
import { ElizaError } from "@elizaos/core";
import type Stripe from "stripe";
import { z } from "zod";
import { settlementDigest } from "./settlement-digest";
import { retrieveInvoiceBalanceHistory } from "./stripe-invoice-settlement";
import { renewalInvoiceSchema } from "./stripe-settled-invoice-schema";
import {
  bindSubscriptionInvoiceEventEvidence,
  type SubscriptionInvoiceEventEvidence,
} from "./subscription-invoice-event-evidence";

const money = z.number().int().safe().nonnegative();
const invoiceSchema = renewalInvoiceSchema.extend({
  starting_balance: z.number().int().safe(),
  ending_balance: z.number().int().safe().nullable(),
  pre_payment_credit_notes_amount: money,
  post_payment_credit_notes_amount: money,
  status: z.enum(["open", "paid", "uncollectible", "void"]),
  paid: z.boolean(),
  amount_remaining: money,
  status_transitions: z.object({ paid_at: money.nullable() }),
});
const options = { apiVersion: "2024-11-20.acacia", maxNetworkRetries: 0 } as const;
function unavailable(reason: string): never {
  throw new ElizaError("Retained invoice balance observation is unavailable", {
    code: "SUBSCRIPTION_INVOICE_BALANCE_UNAVAILABLE",
    context: { reason },
  });
}
/** Projects a current provider invoice without changing the retained original's identity. */
export function projectRetainedInvoiceState(raw: unknown, value: SubscriptionInvoiceEventEvidence) {
  const original = bindSubscriptionInvoiceEventEvidence(value, value.scope);
  const scope = original.scope,
    initial = original.event.data.object;
  const parsed = invoiceSchema.safeParse(raw);
  if (!parsed.success) unavailable("unsupported_invoice_shape");
  const current = parsed.data,
    line = current.lines.data[0]!,
    originalLine = initial.lines.data[0]!;
  if (
    current.id !== scope.invoiceId ||
    current.customer !== scope.customerId ||
    current.subscription !== scope.providerSubscriptionId ||
    current.livemode !== scope.livemode ||
    current.currency !== initial.currency ||
    line.id !== originalLine.id ||
    line.subscription !== originalLine.subscription ||
    line.subscription_item !== originalLine.subscription_item ||
    line.price.id !== originalLine.price.id ||
    line.price.product !== originalLine.price.product ||
    line.period.start !== originalLine.period.start ||
    line.period.end !== originalLine.period.end
  )
    unavailable("original_invoice_identity_changed");
  return current;
}
/** Caller supplies the original receipt's evidence and an authenticated read-only deadline client.
 * Provider consistency checks detect observed changes, not an atomic provider snapshot.
 * The caller must recheck receipt lease and organization fencing before durable publication. */
export async function observeRetainedInvoiceBalance(
  value: SubscriptionInvoiceEventEvidence,
  stripe: Pick<Stripe, "accounts" | "invoices" | "customers">,
) {
  const original = bindSubscriptionInvoiceEventEvidence(value, value.scope);
  const scope = original.scope,
    initial = original.event.data.object;
  if (initial.starting_balance <= 0 && initial.ending_balance <= 0)
    unavailable("original_debit_required");
  let requests = 0;
  async function read(operation: () => Promise<unknown>): Promise<unknown> {
    if (++requests > 240) unavailable("observation_request_limit");
    try {
      return JSON.parse(JSON.stringify(await operation())) as unknown;
    } catch {
      // error-policy:J1 Provider errors can contain private invoice or credential material.
      unavailable("provider_read_failed");
    }
  }
  async function account() {
    const parsed = z
      .object({ id: z.string(), object: z.literal("account") })
      .safeParse(await read(() => stripe.accounts.retrieve(null, {}, options)));
    if (!parsed.success || parsed.data.id !== scope.providerAccountId)
      unavailable("merchant_mismatch");
  }
  async function invoice() {
    return projectRetainedInvoiceState(
      await read(() => stripe.invoices.retrieve(scope.invoiceId, {}, options)),
      original,
    );
  }
  async function snapshot() {
    await account();
    const before = await invoice();
    const history = await retrieveInvoiceBalanceHistory(
      scope.customerId,
      scope.livemode,
      (customerId, params) =>
        read(() => stripe.customers.listBalanceTransactions(customerId, params, options)),
    );
    if (!history.data.some((row) => row.invoice === scope.invoiceId))
      unavailable("original_invoice_posting_missing");
    for (let index = 0; index < history.data.length; index++) {
      const row = history.data[index]!,
        older = history.data[index + 1];
      if (row.currency !== initial.currency) unavailable("ledger_currency_mismatch");
      if (
        older &&
        (row.created < older.created ||
          BigInt(row.ending_balance) - BigInt(row.amount) !== BigInt(older.ending_balance))
      )
        unavailable("ledger_discontinuity");
    }
    const after = await invoice();
    await account();
    if (settlementDigest(before) !== settlementDigest(after))
      unavailable("invoice_changed_during_read");
    return { invoice: after, history };
  }
  const first = await snapshot(),
    second = await snapshot();
  if (settlementDigest(first) !== settlementDigest(second))
    unavailable("observation_changed_during_read");
  const body = {
    kind: "retained_invoice_balance_observation" as const,
    version: 1 as const,
    organizationId: scope.organizationId,
    subscriptionId: scope.subscriptionId,
    originalEvidenceDigest: original.digest,
    providerAccountId: scope.providerAccountId,
    customerId: scope.customerId,
    invoiceId: scope.invoiceId,
    livemode: scope.livemode,
    currency: initial.currency,
    ...second,
  };
  return { ...body, digest: settlementDigest(body) };
}
