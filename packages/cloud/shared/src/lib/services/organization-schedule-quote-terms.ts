/** Private canonical source/customer terms retained by one original downgrade quote. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import {
  observeOrganizationScheduleRetainedTerms,
  organizationScheduleRetainedSubscriptionSchema,
} from "./organization-schedule-retained-terms";
import { settlementDigest } from "./settlement-digest";

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = (prefix: string) =>
  z.union([
    id(prefix),
    z.object({ id: id(prefix), deleted: z.literal(false).optional() }).transform((x) => x.id),
  ]);
export const organizationScheduleCustomerTermsSchema = z
  .object({
    customerId: id("cus"),
    livemode: z.boolean(),
    defaultPaymentMethod: id("pm").nullable(),
    discountId: id("di").nullable(),
    currency: z.literal("usd").nullable(),
    balance: z.number().int().safe(),
    taxExempt: z.enum(["none", "exempt", "reverse"]).nullable(),
    financialContextDigest: digest,
  })
  .strict();
const customerResponse = z.object({
  id: id("cus"),
  object: z.literal("customer"),
  livemode: z.boolean(),
  deleted: z.literal(false).optional(),
  default_source: z.null(),
  invoice_settings: z.object({ default_payment_method: reference("pm").nullable() }),
  discount: z
    .object({ id: id("di") })
    .passthrough()
    .nullable(),
  currency: z.literal("usd").nullable(),
  balance: z.number().int().safe(),
  invoice_credit_balance: z.record(z.string(), z.number().int().safe()).optional(),
  tax_exempt: z.enum(["none", "exempt", "reverse"]).nullable(),
  address: z.record(z.string(), z.unknown()).nullable(),
  shipping: z.record(z.string(), z.unknown()).nullable(),
  tax_ids: z.object({
    object: z.literal("list"),
    has_more: z.literal(false),
    data: z.array(z.object({ id: id("txi"), object: z.literal("tax_id") }).passthrough()),
  }),
});
function reject(): never {
  throw new ElizaError("Schedule quote requires complete original provider terms", {
    code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE",
  });
}
/** Customer response must request tax_ids expansion; incomplete pages cannot authorize a write.
 * Persist only opaque context digests for addresses/tax identifiers, not their raw values.
 */
export function observeOrganizationScheduleCustomerTerms(raw: unknown) {
  const parsed = customerResponse.safeParse(raw);
  if (!parsed.success) reject();
  const c = parsed.data;
  return organizationScheduleCustomerTermsSchema.parse({
    customerId: c.id,
    livemode: c.livemode,
    defaultPaymentMethod: c.invoice_settings.default_payment_method,
    discountId: c.discount?.id ?? null,
    currency: c.currency,
    balance: c.balance,
    taxExempt: c.tax_exempt,
    financialContextDigest: settlementDigest({
      address: c.address,
      shipping: c.shipping,
      taxIds: c.tax_ids.data,
      discount: c.discount,
      invoiceCreditBalance: c.invoice_credit_balance ?? {},
    }),
  });
}
export const organizationScheduleQuoteTermsSchema = z
  .object({
    version: z.literal(1),
    subscription: organizationScheduleRetainedSubscriptionSchema,
    customer: organizationScheduleCustomerTermsSchema,
  })
  .strict();
export type OrganizationScheduleQuoteTerms = z.infer<typeof organizationScheduleQuoteTermsSchema>;
export function captureOrganizationScheduleQuoteTerms(input: {
  rawSubscription: unknown;
  rawCustomer: unknown;
  observedAt: Date;
}): OrganizationScheduleQuoteTerms {
  observeOrganizationScheduleRetainedTerms({
    raw: input.rawSubscription,
    observedAt: input.observedAt,
  });
  const subscription = organizationScheduleRetainedSubscriptionSchema.parse(input.rawSubscription);
  const customer = observeOrganizationScheduleCustomerTerms(input.rawCustomer);
  if (subscription.customer !== customer.customerId || subscription.livemode !== customer.livemode)
    reject();
  return organizationScheduleQuoteTermsSchema.parse({ version: 1, subscription, customer });
}

/** Revalidate the same binding immediately before dispatch; a mismatch requires a new review. */
export function assertOrganizationScheduleQuoteTermsCurrent(input: {
  original: OrganizationScheduleQuoteTerms;
  rawSubscription: unknown;
  rawCustomer: unknown;
  observedAt: Date;
}) {
  const original = organizationScheduleQuoteTermsSchema.parse(input.original);
  const current = captureOrganizationScheduleQuoteTerms(input);
  if (settlementDigest(original) !== settlementDigest(current)) reject();
  return current;
}
