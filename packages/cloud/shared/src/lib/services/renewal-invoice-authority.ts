/** Retains original renewal identity in its grant; never reconstructs history from current provider state. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { settlementDigest } from "./settlement-digest";

const identifier = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_]+$`));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const amount = z.number().int().safe().nonnegative();
const authoritySchema = z
  .object({
    kind: z.literal("renewal_invoice_authority"),
    version: z.literal(1),
    organizationId: z.string().uuid(),
    subscriptionId: z.string().uuid(),
    providerAccountId: identifier("acct").nullable(),
    invoiceId: identifier("in"),
    customerId: identifier("cus"),
    providerSubscriptionId: identifier("sub"),
    subscriptionItemId: identifier("si"),
    invoiceLineId: identifier("il"),
    priceId: identifier("price"),
    productId: identifier("prod"),
    livemode: z.boolean(),
    currency: z.literal("usd"),
    periodStart: amount,
    periodEnd: amount,
    invoiceTotal: amount,
    amountPaid: amount,
    paymentIntentId: identifier("pi").nullable(),
    chargeId: identifier("ch").nullable(),
    adjustmentDigest: hash.nullable(),
    settlementDigest: hash.nullable(),
    grantDigest: hash,
  })
  .strict();
export type RenewalInvoiceAuthority = z.infer<typeof authoritySchema> & { digest: string };

function unavailable(): never {
  throw new ElizaError("Original renewal invoice authority does not match the grant", {
    code: "SUBSCRIPTION_RENEWAL_AUTHORITY_CONFLICT",
  });
}

export function createRenewalInvoiceAuthority(
  value: z.infer<typeof authoritySchema>,
): RenewalInvoiceAuthority {
  const parsed = authoritySchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.periodEnd <= parsed.data.periodStart ||
    (parsed.data.amountPaid === 0
      ? parsed.data.paymentIntentId !== null || parsed.data.chargeId !== null
      : parsed.data.paymentIntentId === null || parsed.data.chargeId === null)
  )
    unavailable();
  return { ...parsed.data, digest: settlementDigest(parsed.data) };
}

/** Validates and copies before any database await. A missing merchant stays unknown,
 * and cannot later be used as permission to observe another merchant's objects. */
export function bindRenewalInvoiceAuthority(
  value: RenewalInvoiceAuthority,
  source: BillingSubscription,
  invoiceId: string,
  grantDigest: string,
): RenewalInvoiceAuthority {
  const parsed = authoritySchema.extend({ digest: hash }).safeParse(value);
  if (!parsed.success) unavailable();
  const { digest, ...body } = parsed.data;
  const canonical = createRenewalInvoiceAuthority(body);
  if (
    digest !== canonical.digest ||
    body.grantDigest !== grantDigest ||
    body.organizationId !== source.organization_id ||
    body.subscriptionId !== source.id ||
    body.invoiceId !== invoiceId ||
    body.customerId !== source.stripe_customer_id ||
    body.providerSubscriptionId !== source.stripe_subscription_id ||
    body.subscriptionItemId !== source.stripe_subscription_item_id ||
    body.livemode !== (source.provider_environment === "live") ||
    body.periodStart * 1000 !== source.current_period_start?.getTime() ||
    body.periodEnd * 1000 !== source.current_period_end?.getTime()
  )
    unavailable();
  return canonical;
}
