/** Proves captured remainder or explicit invoice credit settlement; deferred debt is not payment. */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";

const integer = z.number().int().safe();
const transaction = z.object({
  id: z.string().regex(/^cbtxn_[A-Za-z0-9]+$/),
  object: z.literal("customer_balance_transaction"),
  customer: z.string(),
  invoice: z.string().nullable(),
  livemode: z.boolean(),
  currency: z.string(),
  amount: integer,
  ending_balance: integer,
  created: integer.nonnegative(),
  type: z.string(),
  credit_note: z.string().nullable(),
});
export const invoiceBalanceHistorySchema = z.object({
  object: z.literal("list"),
  has_more: z.boolean(),
  data: z.array(transaction),
});
export type InvoiceBalanceHistory = {
  object: "list";
  has_more: false;
  data: z.infer<typeof transaction>[];
};
function unavailable(reason: string): never {
  throw new ElizaError("Invoice settlement requires original balance authority", {
    code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
    context: { reason },
  });
}
/** Read the complete immutable ledger and recheck its head. A bounded scan fails explicitly,
 * never claims a truncated history is complete. Descriptions/metadata are not authority. */
export async function retrieveInvoiceBalanceHistory(
  customerId: string,
  livemode: boolean,
  list: (
    customerId: string,
    params: { limit: number; starting_after?: string },
  ) => Promise<unknown>,
): Promise<InvoiceBalanceHistory> {
  const rows: z.infer<typeof transaction>[] = [],
    seen = new Set<string>();
  let cursor: string | undefined;
  for (let index = 0; index < 100; index++) {
    const result = invoiceBalanceHistorySchema.safeParse(
      await list(customerId, { limit: 100, ...(cursor ? { starting_after: cursor } : {}) }),
    );
    if (!result.success || result.data.data.length > 100) unavailable("invalid_balance_page");
    for (const row of result.data.data) {
      if (row.customer !== customerId || row.livemode !== livemode || seen.has(row.id))
        unavailable("foreign_or_repeated_balance_transaction");
      seen.add(row.id);
      rows.push(row);
    }
    if (!result.data.has_more) {
      const head = invoiceBalanceHistorySchema.safeParse(await list(customerId, { limit: 1 }));
      if (
        !head.success ||
        head.data.data.length > 1 ||
        JSON.stringify(head.data.data[0] ?? null) !== JSON.stringify(rows[0] ?? null)
      )
        unavailable("balance_history_changed");
      return { object: "list", has_more: false, data: rows };
    }
    cursor = result.data.data.at(-1)?.id;
    if (!cursor) unavailable("empty_nonterminal_balance_page");
  }
  unavailable("balance_history_scan_limit");
}
export function proveInvoiceSettlement(
  invoice: {
    id: string;
    customer: string;
    livemode: boolean;
    currency: string;
    total: number;
    amount_due: number;
    amount_paid: number;
    starting_balance: number;
    ending_balance: number;
    status_transitions: { paid_at: number };
  },
  history?: unknown,
) {
  const start = BigInt(invoice.starting_balance),
    end = BigInt(invoice.ending_balance);
  const total = BigInt(invoice.total),
    due = BigInt(invoice.amount_due);
  if (start > 0n || end > 0n || invoice.amount_paid !== invoice.amount_due)
    unavailable("unsettled_or_deferred_invoice_debt");
  const credit = start < 0n ? (-start < total ? -start : total) : 0n;
  if (end !== start + credit || due !== total - credit)
    unavailable("invoice_balance_arithmetic_mismatch");
  if (start === 0n) return undefined;
  const parsed = invoiceBalanceHistorySchema.safeParse(history);
  if (!parsed.success || parsed.data.has_more) unavailable("complete_balance_history_required");
  const ids = new Set<string>();
  for (const row of parsed.data.data) {
    if (ids.has(row.id) || row.customer !== invoice.customer || row.livemode !== invoice.livemode)
      unavailable("foreign_or_repeated_balance_transaction");
    ids.add(row.id);
  }
  const linked = parsed.data.data.filter((row) => row.invoice === invoice.id);
  // No applied amount is expected for a fully waived invoice that leaves credit untouched.
  if (credit === 0n) {
    if (linked.length) unavailable("unexpected_balance_application");
  } else {
    const row = linked[0];
    if (
      linked.length !== 1 ||
      !row ||
      row.type !== "applied_to_invoice" ||
      row.credit_note !== null ||
      row.currency !== invoice.currency ||
      BigInt(row.amount) !== credit ||
      BigInt(row.ending_balance) !== end ||
      row.created > invoice.status_transitions.paid_at
    )
      unavailable("missing_or_reversed_invoice_credit");
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        "invoice-credit-settlement-v1",
        invoice.starting_balance,
        invoice.ending_balance,
        invoice.total,
        invoice.amount_due,
        linked,
      ]),
    )
    .digest("hex");
}
