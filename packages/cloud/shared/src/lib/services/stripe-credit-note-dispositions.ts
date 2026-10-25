/** Reconciles linked Acacia dispositions, never entitlement or a new allowance. */
import { ElizaError } from "@elizaos/core";
import type Stripe from "stripe";
import { z } from "zod";
import { settlementDigest } from "./settlement-digest";
import {
  type InvoiceCreditNoteScope,
  retrieveInvoiceCreditNotes,
} from "./stripe-credit-note-observation";

const integer = z.number().int().safe();
const money = integer.nonnegative();
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_]+$`));
const invoiceBinding = z.object({
  id: id("in"),
  object: z.literal("invoice"),
  customer: id("cus"),
  livemode: z.boolean(),
  currency: z.string(),
  status: z.string(),
  charge: id("ch").nullable(),
  payment_intent: id("pi").nullable(),
  paid_out_of_band: z.literal(false),
  collection_method: z.literal("charge_automatically"),
  amount_paid: money,
  amount_due: money,
  amount_remaining: money,
  application: z.null(),
  application_fee_amount: z.null(),
  on_behalf_of: z.null(),
  transfer_data: z.null(),
  issuer: z.object({ type: z.literal("self") }),
});
const platformPayment = {
  customer: id("cus"),
  invoice: id("in"),
  livemode: z.boolean(),
  currency: z.string(),
  amount: money.positive(),
  status: z.literal("succeeded"),
  application: z.null(),
  application_fee_amount: z.null(),
  on_behalf_of: z.null(),
  transfer_data: z.null(),
};
const chargeSchema = z.object({
  ...platformPayment,
  id: id("ch"),
  object: z.literal("charge"),
  payment_intent: id("pi"),
  amount_captured: money.positive(),
  amount_refunded: money,
  paid: z.literal(true),
  captured: z.literal(true),
  disputed: z.literal(false),
  refunded: z.boolean(),
  application_fee: z.null(),
  transfer: z.null().optional(),
});
const paymentSchema = z.object({
  ...platformPayment,
  id: id("pi"),
  object: z.literal("payment_intent"),
  latest_charge: id("ch"),
  amount_received: money.positive(),
  amount_capturable: z.literal(0),
});
const refundSchema = z.object({
  id: id("re"),
  object: z.literal("refund"),
  amount: money.positive(),
  currency: z.string(),
  charge: id("ch"),
  payment_intent: id("pi"),
  created: money,
  status: z.literal("succeeded"),
  balance_transaction: id("txn"),
  failure_balance_transaction: z.null().optional(),
  failure_reason: z.null().optional(),
  source_transfer_reversal: z.null(),
  transfer_reversal: z.null(),
});
const merchantBalanceSchema = z.object({
  id: id("txn"),
  object: z.literal("balance_transaction"),
  source: id("re"),
  type: z.enum(["refund", "payment_refund"]),
  currency: z.string(),
  exchange_rate: z.null(),
  amount: integer.negative(),
  fee: integer,
  net: integer,
  created: money,
  status: z.enum(["pending", "available"]),
  available_on: money,
});
const customerBalanceSchema = z.object({
  id: id("cbtxn"),
  object: z.literal("customer_balance_transaction"),
  type: z.literal("credit_note"),
  customer: id("cus"),
  invoice: id("in").nullable(),
  credit_note: id("cn"),
  livemode: z.boolean(),
  currency: z.string(),
  created: money,
  amount: integer.negative(),
  ending_balance: integer,
});
const options = { apiVersion: "2024-11-20.acacia", maxNetworkRetries: 0 } as const;
function reject(reason: string): never {
  throw new ElizaError("Credit-note dispositions require original reconciled provider evidence", {
    code: "SUBSCRIPTION_CREDIT_NOTE_DISPOSITIONS_UNAVAILABLE",
    context: { reason },
  });
}
type Client = Pick<
  Stripe,
  | "accounts"
  | "invoices"
  | "creditNotes"
  | "customers"
  | "refunds"
  | "charges"
  | "paymentIntents"
  | "balanceTransactions"
>;

/** Original note observations bracket two complete linked-evidence reads. Equal reads
 * detect observed races, not atomicity. No provider write, allowance change or bank
 * receipt is implied. Out-of-band credits require independent evidence and reject.
 * Standalone/unattributed refunds, Connect and FX remain unsupported explicitly.
 * A customer credit posting proves its original creation, not the current available balance. */
export async function retrieveInvoiceCreditNoteDispositions(
  expected: InvoiceCreditNoteScope,
  stripe: Client,
) {
  const original = await retrieveInvoiceCreditNotes(expected, stripe);
  const scope = {
    providerAccountId: original.providerAccountId,
    invoiceId: original.invoice.id,
    customerId: original.invoice.customer,
    currency: original.invoice.currency,
    livemode: original.invoice.livemode,
    invoiceLineIds: [...original.invoiceLineIds],
  };
  let requests = 0;
  async function read<T extends z.ZodType>(
    schema: T,
    operation: () => Promise<unknown>,
  ): Promise<z.infer<T>> {
    if (++requests > 2000) reject("linked_evidence_request_limit");
    let raw: unknown;
    try {
      raw = JSON.parse(JSON.stringify(await operation())) as unknown;
    } catch {
      // error-policy:J1 provider errors may contain credentials or private payment details.
      reject("linked_evidence_read_failed");
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) reject("unsupported_linked_evidence");
    return parsed.data;
  }
  async function collectRefunds(chargeId: string) {
    const rows: z.infer<typeof refundSchema>[] = [],
      seen = new Set<string>();
    const page = z.object({
      object: z.literal("list"),
      has_more: z.boolean(),
      data: z.array(refundSchema).max(100),
    });
    let cursor: string | undefined;
    for (let index = 0; index < 100; index++) {
      const result = await read(page, () =>
        stripe.refunds.list(
          { charge: chargeId, limit: 100, ...(cursor ? { starting_after: cursor } : {}) },
          options,
        ),
      );
      for (const row of result.data) {
        if (seen.has(row.id)) reject("duplicate_refund_history");
        seen.add(row.id);
        rows.push(row);
        cursor = row.id;
      }
      if (!result.has_more) return rows;
      if (!result.data.length) reject("empty_nonterminal_refund_history");
    }
    reject("refund_history_page_limit");
  }
  async function bundle() {
    const invoice = await read(invoiceBinding, () =>
      stripe.invoices.retrieve(scope.invoiceId, {}, options),
    );
    if (
      invoice.id !== original.invoice.id ||
      invoice.customer !== scope.customerId ||
      invoice.livemode !== scope.livemode ||
      invoice.currency !== scope.currency ||
      invoice.status !== original.invoice.status ||
      invoice.amount_due !== original.invoice.amount_due ||
      invoice.amount_paid !== original.invoice.amount_paid ||
      invoice.amount_remaining !== original.invoice.amount_remaining
    )
      reject("original_invoice_binding_changed");
    const post = original.notes.filter(
      (note) => note.status === "issued" && note.type === "post_payment",
    );
    let charge: z.infer<typeof chargeSchema> | null = null;
    let payment: z.infer<typeof paymentSchema> | null = null;
    let refunds: z.infer<typeof refundSchema>[] = [];
    if (post.length) {
      if (
        invoice.status !== "paid" ||
        invoice.amount_remaining !== 0 ||
        invoice.amount_due !== invoice.amount_paid
      )
        reject("post_payment_invoice_not_settled");
      if (invoice.amount_paid === 0) {
        if (invoice.charge !== null || invoice.payment_intent !== null)
          reject("zero_paid_has_capture_reference");
      } else {
        if (!invoice.charge || !invoice.payment_intent) reject("original_capture_missing");
        charge = await read(chargeSchema, () =>
          stripe.charges.retrieve(invoice.charge!, {}, options),
        );
        payment = await read(paymentSchema, () =>
          stripe.paymentIntents.retrieve(invoice.payment_intent!, {}, options),
        );
        if (
          charge.id !== invoice.charge ||
          payment.id !== invoice.payment_intent ||
          charge.payment_intent !== payment.id ||
          payment.latest_charge !== charge.id ||
          [charge, payment].some(
            (value) =>
              value.customer !== scope.customerId ||
              value.invoice !== scope.invoiceId ||
              value.livemode !== scope.livemode ||
              value.currency !== scope.currency ||
              value.amount !== invoice.amount_paid,
          ) ||
          charge.amount_captured !== invoice.amount_paid ||
          payment.amount_received !== invoice.amount_paid ||
          charge.amount_refunded > charge.amount_captured ||
          charge.refunded !== (charge.amount_refunded === charge.amount_captured)
        )
          reject("original_capture_mismatch");
        refunds = await collectRefunds(charge.id);
      }
    }
    const seenRefunds = new Set<string>(),
      seenBalances = new Set<string>();
    const dispositions = [];
    for (const note of original.notes) {
      if ((note.out_of_band_amount ?? 0) !== 0)
        reject("out_of_band_credit_requires_independent_evidence");
      if (note.status === "void" || note.type === "pre_payment") {
        if (note.refund !== null || note.customer_balance_transaction !== null)
          reject("unexpected_pre_payment_or_void_disposition");
        dispositions.push({
          noteId: note.id,
          prePaymentReduction: note.status === "void" ? 0 : note.total,
          refund: null,
          merchantBalance: null,
          customerBalance: null,
        });
        continue;
      }
      let refund: z.infer<typeof refundSchema> | null = null;
      let merchantBalance: z.infer<typeof merchantBalanceSchema> | null = null;
      let customerBalance: z.infer<typeof customerBalanceSchema> | null = null;
      if (note.refund !== null) {
        if (!charge || !payment || seenRefunds.has(note.refund))
          reject("missing_capture_or_duplicate_refund_allocation");
        seenRefunds.add(note.refund);
        refund = await read(refundSchema, () => stripe.refunds.retrieve(note.refund!, {}, options));
        if (
          refund.id !== note.refund ||
          refund.charge !== charge.id ||
          refund.payment_intent !== payment.id ||
          refund.currency !== scope.currency ||
          settlementDigest(refunds.find((row) => row.id === refund!.id) ?? null) !==
            settlementDigest(refund)
        )
          reject("refund_original_payment_mismatch");
        const refundBalanceId = refund.balance_transaction;
        merchantBalance = await read(merchantBalanceSchema, () =>
          stripe.balanceTransactions.retrieve(refundBalanceId, {}, options),
        );
        if (
          merchantBalance.id !== refundBalanceId ||
          merchantBalance.source !== refund.id ||
          merchantBalance.currency !== scope.currency ||
          BigInt(merchantBalance.amount) !== -BigInt(refund.amount) ||
          BigInt(merchantBalance.net) !==
            BigInt(merchantBalance.amount) - BigInt(merchantBalance.fee)
        )
          reject("refund_merchant_balance_mismatch");
      }
      if (note.customer_balance_transaction !== null) {
        if (seenBalances.has(note.customer_balance_transaction))
          reject("duplicate_customer_credit_allocation");
        seenBalances.add(note.customer_balance_transaction);
        customerBalance = await read(customerBalanceSchema, () =>
          stripe.customers.retrieveBalanceTransaction(
            scope.customerId,
            note.customer_balance_transaction!,
            {},
            options,
          ),
        );
        if (
          customerBalance.id !== note.customer_balance_transaction ||
          customerBalance.customer !== scope.customerId ||
          (customerBalance.invoice !== null && customerBalance.invoice !== scope.invoiceId) ||
          customerBalance.credit_note !== note.id ||
          customerBalance.livemode !== scope.livemode ||
          customerBalance.currency !== scope.currency
        )
          reject("customer_credit_note_mismatch");
      }
      if (BigInt(refund?.amount ?? 0) - BigInt(customerBalance?.amount ?? 0) !== BigInt(note.total))
        reject("credit_note_disposition_total_mismatch");
      dispositions.push({
        noteId: note.id,
        prePaymentReduction: 0,
        refund,
        merchantBalance,
        customerBalance,
      });
    }
    if (
      charge &&
      (refunds.length !== seenRefunds.size ||
        refunds.some((refund) => !seenRefunds.has(refund.id)) ||
        refunds.reduce((sum, refund) => sum + BigInt(refund.amount), 0n) !==
          BigInt(charge.amount_refunded))
    )
      reject("unattributed_or_inconsistent_charge_refunds");
    return { invoice, charge, payment, dispositions };
  }
  const first = await bundle(),
    second = await bundle();
  const current = await retrieveInvoiceCreditNotes(scope, stripe);
  if (original.digest !== current.digest || settlementDigest(first) !== settlementDigest(second))
    reject("credit_note_dispositions_changed");
  const observation = {
    kind: "invoice_credit_note_dispositions" as const,
    version: 1 as const,
    noteObservation: current,
    ...second,
  };
  return { ...observation, digest: settlementDigest(observation) };
}
