/** Complete authenticated invoice traversal selects an adjacent interval, never payment authority. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";

export interface RenewalInvoiceReader {
  list(
    input: { subscription: string; limit: 100; created: { lte: number }; starting_after?: string },
    options: { apiVersion: "2024-11-20.acacia" },
  ): Promise<unknown>;
}
const seconds = z.number().int().nonnegative().safe();
const pageSchema = z.object({
  object: z.literal("list"),
  has_more: z.boolean(),
  data: z.array(z.unknown()).max(100),
});
const invoiceSchema = z.object({
  id: z.string().regex(/^in_[A-Za-z0-9]+$/),
  object: z.literal("invoice"),
  subscription: z.string(),
  customer: z.string(),
  livemode: z.boolean(),
  created: seconds,
  billing_reason: z.string(),
  status: z.enum(["draft", "open", "paid", "uncollectible", "void"]),
  lines: z.object({
    has_more: z.literal(false),
    data: z.array(
      z.object({
        type: z.string(),
        subscription: z.string().nullable(),
        proration: z.boolean(),
        period: z.object({ start: seconds, end: seconds }),
      }),
    ),
  }),
});
function reject(reason: string): never {
  throw new ElizaError("Next renewal requires complete unambiguous invoice history", {
    code: "SUBSCRIPTION_RECONCILIATION_UNAVAILABLE",
    context: { reason },
  });
}
/** The caller supplies the authenticated account reader and retained source identity.
 * Finish every page before returning; callers must retrieve and validate money and
 * current state again under the existing source/receipt publication contract. */
export async function findNextRenewalInvoice(input: {
  reader: RenewalInvoiceReader;
  subscriptionId: string;
  customerId: string;
  livemode: boolean;
  paidPeriodEnd: Date;
  observedAt: Date;
}) {
  const boundary = input.paidPeriodEnd.getTime() / 1000,
    upper = Math.floor(input.observedAt.getTime() / 1000);
  if (
    !Number.isSafeInteger(boundary) ||
    boundary < 0 ||
    !Number.isSafeInteger(upper) ||
    upper < boundary ||
    !/^sub_[A-Za-z0-9]+$/.test(input.subscriptionId) ||
    !input.customerId
  )
    reject("invalid_invoice_search_identity_or_clock");
  const seen = new Set<string>();
  let cursor: string | undefined,
    match:
      | {
          invoiceId: string;
          status: "draft" | "open" | "paid" | "uncollectible" | "void";
          periodEnd: Date;
        }
      | undefined;
  for (;;) {
    const page = pageSchema.safeParse(
      await input.reader.list(
        {
          subscription: input.subscriptionId,
          limit: 100,
          created: { lte: upper },
          ...(cursor ? { starting_after: cursor } : {}),
        },
        { apiVersion: "2024-11-20.acacia" },
      ),
    );
    if (!page.success || (page.data.has_more && page.data.data.length === 0))
      reject("incomplete_invoice_history");
    for (const raw of page.data.data) {
      const parsed = invoiceSchema.safeParse(raw);
      if (!parsed.success) reject("unsupported_invoice_history_shape");
      const invoice = parsed.data;
      if (
        seen.has(invoice.id) ||
        invoice.subscription !== input.subscriptionId ||
        invoice.customer !== input.customerId ||
        invoice.livemode !== input.livemode ||
        invoice.created > upper
      )
        reject("invoice_history_identity_or_cursor_changed");
      seen.add(invoice.id);
      cursor = invoice.id;
      for (const line of invoice.lines.data) {
        if (
          !Number.isFinite(new Date(line.period.start * 1000).getTime()) ||
          !Number.isFinite(new Date(line.period.end * 1000).getTime()) ||
          line.period.start >= line.period.end
        )
          reject("invalid_invoice_history_period");
        if (line.type !== "subscription" || line.proration) continue;
        if (line.subscription !== input.subscriptionId) reject("foreign_recurring_line");
        if (line.period.start < boundary && line.period.end > boundary)
          reject("overlapping_recurring_invoice");
        if (line.period.start !== boundary) continue;
        if (
          invoice.billing_reason !== "subscription_cycle" ||
          invoice.lines.data.length !== 1 ||
          match
        )
          reject("ambiguous_adjacent_invoice");
        match = {
          invoiceId: invoice.id,
          status: invoice.status,
          periodEnd: new Date(line.period.end * 1000),
        };
      }
    }
    if (!page.data.has_more) {
      if (!match) reject("adjacent_invoice_missing");
      if (!["paid", "open", "uncollectible"].includes(match.status))
        reject("adjacent_invoice_unpaid");
      return {
        invoiceId: match.invoiceId,
        periodEnd: match.periodEnd,
        paid: match.status === "paid",
      };
    }
  }
}
