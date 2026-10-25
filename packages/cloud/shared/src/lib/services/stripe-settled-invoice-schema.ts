/** Private, field-projected invoice shapes shared by settlement and retained evidence. */
import { z } from "zod";
import {
  automaticTax,
  discountAmounts,
  discountReference,
  taxAmounts,
} from "./stripe-invoice-adjustments";

const seconds = z.number().int().nonnegative().safe();
const cents = z.number().int().positive().safe();
export const renewalInvoiceSchema = z.object({
  id: z.string().regex(/^in_[A-Za-z0-9]+$/),
  object: z.literal("invoice"),
  subscription: z.string().regex(/^sub_[A-Za-z0-9]+$/),
  customer: z.string(),
  livemode: z.boolean(),
  billing_reason: z.literal("subscription_cycle"),
  status: z.literal("paid"),
  paid: z.literal(true),
  paid_out_of_band: z.literal(false),
  collection_method: z.literal("charge_automatically"),
  currency: z.literal("usd"),
  amount_paid: seconds,
  amount_due: seconds,
  total: seconds,
  subtotal: seconds,
  amount_remaining: z.literal(0),
  starting_balance: z.number().int().safe().nonpositive(),
  ending_balance: z.number().int().safe().nonpositive(),
  pre_payment_credit_notes_amount: z.literal(0),
  post_payment_credit_notes_amount: z.literal(0),
  discount: discountReference.nullable(),
  discounts: z.array(discountReference),
  total_discount_amounts: discountAmounts,
  tax: seconds.nullable(),
  total_tax_amounts: taxAmounts,
  automatic_tax: automaticTax,
  application: z.null(),
  application_fee_amount: z.null(),
  on_behalf_of: z.null(),
  transfer_data: z.null(),
  issuer: z.object({ type: z.literal("self") }),
  payment_intent: z
    .string()
    .regex(/^pi_[A-Za-z0-9]+$/)
    .nullable(),
  charge: z
    .string()
    .regex(/^ch_[A-Za-z0-9]+$/)
    .nullable(),
  status_transitions: z.object({ paid_at: seconds }),
  lines: z.object({
    has_more: z.literal(false),
    data: z
      .array(
        z.object({
          id: z.string(),
          type: z.literal("subscription"),
          subscription: z.string(),
          subscription_item: z.string(),
          quantity: z.literal(1),
          proration: z.literal(false),
          currency: z.literal("usd"),
          amount: cents,
          discounts: z.array(discountReference).default([]),
          discount_amounts: discountAmounts,
          tax_amounts: taxAmounts,
          period: z.object({ start: seconds, end: seconds }),
          price: z.object({ id: z.string(), product: z.string() }),
        }),
      )
      .length(1),
  }),
});
export const initialInvoiceSchema = renewalInvoiceSchema.extend({
  billing_reason: z.literal("subscription_create"),
  // Checkout retains its separate positive-payment contract.
  starting_balance: z.literal(0),
  ending_balance: z.literal(0),
  amount_due: cents,
  amount_paid: cents,
  payment_intent: z.string().regex(/^pi_[A-Za-z0-9]+$/),
  charge: z.string().regex(/^ch_[A-Za-z0-9]+$/),
});
