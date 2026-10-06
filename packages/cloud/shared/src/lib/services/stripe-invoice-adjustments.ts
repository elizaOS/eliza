/** Reconciles single-line Acacia invoice adjustments without changing catalog allowance. */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";

const money = z.number().int().nonnegative().safe();
const discountId = z.string().regex(/^di_[A-Za-z0-9]+$/);
const taxId = z.string().regex(/^txr_[A-Za-z0-9]+$/);
export const discountReference = z.union([
  discountId,
  z.object({ id: discountId }).transform((value) => value.id),
]);
export const discountAmounts = z.array(z.object({ amount: money, discount: discountReference }));
export const taxAmounts = z.array(
  z.object({
    amount: money,
    inclusive: z.boolean(),
    tax_rate: z.union([taxId, z.object({ id: taxId }).transform((value) => value.id)]),
  }),
);
export const automaticTax = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    status: z.literal("complete"),
    liability: z.object({ type: z.literal("self") }).nullable(),
  }),
]);
const invoiceSchema = z.object({
  subtotal: money,
  total: money,
  amount_due: money,
  amount_paid: money,
  discount: discountReference.nullable(),
  discounts: z.array(discountReference),
  total_discount_amounts: discountAmounts,
  tax: money.nullable(),
  total_tax_amounts: taxAmounts,
  automatic_tax: automaticTax,
});
const lineSchema = z.object({
  amount: money,
  discounts: z.array(discountReference).default([]),
  discount_amounts: discountAmounts,
  tax_amounts: taxAmounts,
});
function reject(): never {
  throw new ElizaError("Invoice adjustments do not reconcile", {
    code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
    context: { reason: "invoice_adjustment_arithmetic_mismatch" },
  });
}
function compareIds(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) reject();
  return values;
}
/** Inputs are canonical retrieved invoice data, not client quotes. A digest is omitted for
 * legacy unadjusted invoices so their already-published immutable grants remain replayable. */
export function proveInvoiceAdjustments(invoiceInput: unknown, lineInput: unknown) {
  const invoice = invoiceSchema.parse(invoiceInput),
    line = lineSchema.parse(lineInput);
  const invoiceIds = unique(invoice.discounts),
    itemIds = unique(line.discounts);
  const ids = unique([...invoiceIds, ...itemIds]);
  if (invoice.discount !== null && !invoiceIds.includes(invoice.discount)) reject();
  const allocations = line.discount_amounts.toSorted((a, b) => compareIds(a.discount, b.discount));
  unique(allocations.map((entry) => entry.discount));
  if (
    allocations.length !== ids.length ||
    allocations.some((entry) => !ids.includes(entry.discount))
  )
    reject();
  const aggregate = invoice.total_discount_amounts.toSorted((a, b) =>
    compareIds(a.discount, b.discount),
  );
  if (JSON.stringify(aggregate) !== JSON.stringify(allocations)) reject();
  const sum = (values: number[]) => values.reduce((total, amount) => total + BigInt(amount), 0n);
  const base = BigInt(line.amount);
  const discounts = sum(allocations.map((entry) => entry.amount));
  const itemDiscounts = sum(
    allocations.filter((entry) => itemIds.includes(entry.discount)).map((entry) => entry.amount),
  );
  const taxes = line.tax_amounts.toSorted((a, b) => compareIds(a.tax_rate, b.tax_rate));
  unique(taxes.map((entry) => entry.tax_rate));
  const invoiceTaxes = invoice.total_tax_amounts.toSorted((a, b) =>
    compareIds(a.tax_rate, b.tax_rate),
  );
  if (JSON.stringify(invoiceTaxes) !== JSON.stringify(taxes)) reject();
  const inclusive = sum(taxes.filter((entry) => entry.inclusive).map((entry) => entry.amount));
  const exclusive = sum(taxes.filter((entry) => !entry.inclusive).map((entry) => entry.amount));
  if (
    discounts > base ||
    inclusive > base - discounts ||
    BigInt(invoice.subtotal) !== base - itemDiscounts ||
    BigInt(invoice.total) !== base - discounts + exclusive ||
    BigInt(invoice.tax ?? 0) !== inclusive + exclusive
  )
    reject();
  if (!ids.length && !taxes.length && !invoice.automatic_tax.enabled) return undefined;
  return createHash("sha256")
    .update(
      JSON.stringify([
        "captured-invoice-adjustments-v1",
        line.amount,
        invoice.subtotal,
        invoice.total,
        invoiceIds.toSorted(),
        itemIds.toSorted(),
        allocations,
        taxes,
        invoice.automatic_tax.enabled,
      ]),
    )
    .digest("hex");
}
