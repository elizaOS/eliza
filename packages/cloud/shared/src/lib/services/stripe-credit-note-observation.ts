/** Read-only Acacia observations. A matching double read is not settlement or entitlement authority. */
import { ElizaError } from "@elizaos/core";
import type Stripe from "stripe";
import { z } from "zod";
import { settlementDigest } from "./settlement-digest";
import { discountAmounts, taxAmounts } from "./stripe-invoice-adjustments";

const money = z.number().int().nonnegative().safe();
const seconds = money;
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_]+$`));
const reference = (prefix: string) =>
  z.union([id(prefix), z.object({ id: id(prefix) }).transform((value) => value.id)]);
const decimal = z.string().regex(/^\d+(?:\.\d{1,12})?$/);
const pretaxAmounts = z.array(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("discount"), amount: money, discount: reference("di") }),
    z.object({
      type: z.literal("credit_balance_transaction"),
      amount: money,
      credit_balance_transaction: reference("cbtxn"),
    }),
  ]),
);
const lineSchema = z.object({
  id: id("cnli"),
  object: z.literal("credit_note_line_item"),
  type: z.literal("invoice_line_item"),
  invoice_line_item: id("il"),
  livemode: z.boolean(),
  amount: money,
  amount_excluding_tax: money.nullable(),
  discount_amount: money,
  discount_amounts: discountAmounts,
  quantity: money.positive().nullable(),
  tax_amounts: taxAmounts,
  tax_rates: z.array(reference("txr")),
  unit_amount: money.nullable(),
  unit_amount_decimal: decimal.nullable(),
  unit_amount_excluding_tax: decimal.nullable(),
  pretax_credit_amounts: pretaxAmounts.optional(),
});
const pageOf = <T extends z.ZodType>(schema: T) =>
  z.object({ object: z.literal("list"), has_more: z.boolean(), data: z.array(schema).max(100) });
const noteSchema = z.object({
  id: id("cn"),
  object: z.literal("credit_note"),
  invoice: id("in"),
  customer: id("cus"),
  livemode: z.boolean(),
  currency: z.string().regex(/^[a-z]{3}$/),
  type: z.enum(["pre_payment", "post_payment"]),
  status: z.enum(["issued", "void"]),
  reason: z.enum(["duplicate", "fraudulent", "order_change", "product_unsatisfactory"]).nullable(),
  created: seconds,
  effective_at: seconds.nullable().optional(),
  voided_at: seconds.nullable(),
  amount: money,
  amount_shipping: z.literal(0),
  shipping_cost: z.null(),
  discount_amount: money,
  discount_amounts: discountAmounts,
  subtotal: money,
  subtotal_excluding_tax: money.nullable(),
  tax_amounts: taxAmounts,
  total: money,
  total_excluding_tax: money.nullable(),
  out_of_band_amount: money.nullable(),
  customer_balance_transaction: id("cbtxn").nullable(),
  refund: id("re").nullable(),
  pretax_credit_amounts: pretaxAmounts.optional(),
  lines: pageOf(lineSchema),
});
const invoiceSchema = z.object({
  id: id("in"),
  object: z.literal("invoice"),
  customer: id("cus"),
  livemode: z.boolean(),
  currency: z.string().regex(/^[a-z]{3}$/),
  status: z.enum(["open", "paid", "uncollectible", "void"]),
  total: money,
  amount_due: money,
  amount_paid: money,
  amount_remaining: money,
  starting_balance: z.number().int().safe(),
  ending_balance: z.number().int().safe().nullable(),
  pre_payment_credit_notes_amount: money,
  post_payment_credit_notes_amount: money,
});
const scopeSchema = z.object({
  providerAccountId: id("acct"),
  invoiceId: id("in"),
  customerId: id("cus"),
  livemode: z.boolean(),
  currency: z.string().regex(/^[a-z]{3}$/),
  /** Original validated invoice lines, not a client-supplied allowlist. */
  invoiceLineIds: z.array(id("il")).min(1),
});
export type InvoiceCreditNoteScope = z.infer<typeof scopeSchema>;
type CreditNote = Omit<z.infer<typeof noteSchema>, "lines"> & {
  lines: z.infer<typeof lineSchema>[];
};
const requestOptions = { apiVersion: "2024-11-20.acacia", maxNetworkRetries: 0 } as const;
function unavailable(reason: string): never {
  throw new ElizaError("Invoice credit notes require complete original provider observations", {
    code: "SUBSCRIPTION_CREDIT_NOTES_UNAVAILABLE",
    context: { reason },
  });
}

/** The caller supplies a private platform client and retained scope. No Connect override,
 * provider writes, grant publication or automatic reconciliation is performed here.
 * Complete notes AND lines are read twice: an older note can be voided without a new head.
 * This detects observed changes, not changes after/between reads or an atomic provider snapshot.
 * Callers still need canonical refund/balance evidence, policy and a durable local transaction. */
export async function retrieveInvoiceCreditNotes(
  expected: InvoiceCreditNoteScope,
  stripe: Pick<Stripe, "accounts" | "invoices" | "creditNotes">,
) {
  const parsedScope = scopeSchema.safeParse(expected);
  if (!parsedScope.success) unavailable("invalid_retained_scope");
  const scope = parsedScope.data;
  const allowedLines = new Set(scope.invoiceLineIds);
  if (allowedLines.size !== scope.invoiceLineIds.length) unavailable("duplicate_retained_line");
  // Bounds are explicit failures, never evidence that a partial traversal is complete.
  let requests = 0;
  async function read(operation: () => Promise<unknown>): Promise<unknown> {
    if (++requests > 2000) unavailable("credit_note_request_limit");
    try {
      // Stripe 22 wraps decimal strings in Decimal objects. Restore their exact
      // JSON strings before validation; never coerce monetary decimals to Number.
      return JSON.parse(JSON.stringify(await operation())) as unknown;
    } catch {
      // error-policy:J1 provider errors may contain credentials or private invoice details.
      unavailable("credit_note_provider_read_failed");
    }
  }
  async function verifyAccount() {
    const account = z
      .object({ id: id("acct"), object: z.literal("account") })
      .safeParse(await read(() => stripe.accounts.retrieve(null, {}, requestOptions)));
    if (!account.success || account.data.id !== scope.providerAccountId)
      unavailable("credit_note_merchant_mismatch");
  }
  async function invoice() {
    const result = invoiceSchema.safeParse(
      await read(() => stripe.invoices.retrieve(scope.invoiceId, {}, requestOptions)),
    );
    if (!result.success) unavailable("unsupported_credit_note_invoice");
    if (
      result.data.id !== scope.invoiceId ||
      result.data.customer !== scope.customerId ||
      result.data.livemode !== scope.livemode ||
      result.data.currency !== scope.currency
    )
      unavailable("credit_note_invoice_scope_mismatch");
    return result.data;
  }
  async function pages<T extends z.ZodType>(
    schema: T,
    list: (params: { limit: number; starting_after?: string }) => Promise<unknown>,
  ): Promise<z.infer<T>[]> {
    const rows: z.infer<T>[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let index = 0; index < 100; index++) {
      const parsed = pageOf(schema).safeParse(
        await read(() => list({ limit: 100, ...(cursor ? { starting_after: cursor } : {}) })),
      );
      if (!parsed.success) unavailable("unsupported_credit_note_page");
      for (const row of parsed.data.data) {
        const identity = z.object({ id: z.string() }).parse(row).id;
        if (seen.has(identity)) unavailable("duplicate_credit_note_record");
        seen.add(identity);
        cursor = identity;
        rows.push(row);
      }
      if (!parsed.data.has_more) return rows;
      if (!parsed.data.data.length) unavailable("empty_nonterminal_credit_note_page");
    }
    unavailable("credit_note_page_limit");
  }
  async function notes(): Promise<CreditNote[]> {
    const listed = await pages(noteSchema, (params) =>
      stripe.creditNotes.list({ invoice: scope.invoiceId, ...params }, requestOptions),
    );
    const result: CreditNote[] = [];
    const allLineIds = new Set<string>();
    for (const note of listed) {
      if (
        note.invoice !== scope.invoiceId ||
        note.customer !== scope.customerId ||
        note.livemode !== scope.livemode ||
        note.currency !== scope.currency ||
        (note.status === "issued" && note.voided_at !== null) ||
        (note.status === "void" && (note.voided_at === null || note.voided_at < note.created))
      )
        unavailable("credit_note_scope_or_status_mismatch");
      const lines = await pages(lineSchema, (params) =>
        stripe.creditNotes.listLineItems(note.id, params, requestOptions),
      );
      if (!lines.length) unavailable("credit_note_lines_missing");
      for (const line of lines) {
        if (
          line.livemode !== scope.livemode ||
          !allowedLines.has(line.invoice_line_item) ||
          allLineIds.has(line.id)
        )
          unavailable("credit_note_line_scope_mismatch");
        allLineIds.add(line.id);
      }
      const embeddedIds = new Set<string>();
      for (const embedded of note.lines.data) {
        if (
          embeddedIds.has(embedded.id) ||
          settlementDigest(lines.find((line) => line.id === embedded.id) ?? null) !==
            settlementDigest(embedded)
        )
          unavailable("credit_note_embedded_lines_changed");
        embeddedIds.add(embedded.id);
      }
      if (!note.lines.has_more && embeddedIds.size !== lines.length)
        unavailable("credit_note_embedded_lines_changed");
      result.push({
        ...note,
        lines: lines.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      });
    }
    return result.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  await verifyAccount();
  const before = await invoice();
  const first = await notes();
  const second = await notes();
  const after = await invoice();
  await verifyAccount();
  if (
    settlementDigest(before) !== settlementDigest(after) ||
    settlementDigest(first) !== settlementDigest(second)
  )
    unavailable("credit_note_observation_changed");
  for (const type of ["pre_payment", "post_payment"] as const) {
    const total = first
      .filter((note) => note.type === type && note.status === "issued")
      .reduce((sum, note) => sum + BigInt(note.total), 0n);
    if (total !== BigInt(after[`${type}_credit_notes_amount`]))
      unavailable("credit_note_invoice_totals_mismatch");
  }
  const observation = {
    kind: "invoice_credit_note_observation" as const,
    version: 1 as const,
    apiVersion: requestOptions.apiVersion,
    providerAccountId: scope.providerAccountId,
    invoiceLineIds: [...allowedLines].sort(),
    invoice: after,
    notes: second,
  };
  return { ...observation, digest: settlementDigest(observation) };
}
