/** Private original invoice observations. These are not payment or allowance authority. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { settlementDigest } from "./settlement-digest";
import { renewalInvoiceSchema } from "./stripe-settled-invoice-schema";

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const seconds = z.number().int().safe().nonnegative();
const scopeSchema = z
  .object({
    organizationId: z.string().uuid(),
    subscriptionId: z.string().uuid(),
    providerAccountId: id("acct"),
    customerId: id("cus"),
    providerSubscriptionId: id("sub"),
    invoiceId: id("in"),
    providerEventId: id("evt"),
    livemode: z.boolean(),
  })
  .strict();
export type SubscriptionInvoiceEventScope = z.infer<typeof scopeSchema>;
// Preserve debit and credit observations without widening the funded-invoice schema.
const observedInvoiceSchema = renewalInvoiceSchema.extend({
  starting_balance: z.number().int().safe(),
  ending_balance: z.number().int().safe(),
  pre_payment_credit_notes_amount: seconds,
  post_payment_credit_notes_amount: seconds,
});
const eventSchema = z.object({
  id: id("evt"),
  object: z.literal("event"),
  type: z.literal("invoice.paid"),
  api_version: z.literal("2024-11-20.acacia"),
  created: seconds,
  livemode: z.boolean(),
  account: z.never().optional(),
  context: z.never().optional(),
  data: z.object({ object: observedInvoiceSchema }),
});
const bodySchema = z
  .object({
    kind: z.literal("subscription_invoice_event_observation"),
    version: z.literal(1),
    scope: scopeSchema,
    event: eventSchema,
  })
  .strict();
export type SubscriptionInvoiceEventEvidence = z.infer<typeof bodySchema> & { digest: string };
function unavailable(): never {
  throw new ElizaError(
    "Original invoice event evidence is unavailable or conflicts with its owner",
    {
      code: "SUBSCRIPTION_INVOICE_EVENT_EVIDENCE_UNAVAILABLE",
    },
  );
}

/** Caller must authenticate the webhook and derive scope from durable platform ownership.
 * Never call with a later retrieved invoice substituted into the original signed event.
 * A paid status, positive balance or matching digest here does not prove collection. */
export function createSubscriptionInvoiceEventEvidence(
  rawEvent: unknown,
  expected: SubscriptionInvoiceEventScope,
): SubscriptionInvoiceEventEvidence {
  const owner = scopeSchema.safeParse(expected);
  const parsed = eventSchema.safeParse(rawEvent);
  if (!owner.success || !parsed.success) unavailable();
  const scope = owner.data,
    event = parsed.data,
    invoice = event.data.object;
  const line = invoice.lines.data[0];
  if (
    event.id !== scope.providerEventId ||
    event.livemode !== scope.livemode ||
    invoice.id !== scope.invoiceId ||
    invoice.livemode !== scope.livemode ||
    invoice.customer !== scope.customerId ||
    invoice.subscription !== scope.providerSubscriptionId ||
    !line ||
    line.subscription !== scope.providerSubscriptionId ||
    line.period.start >= line.period.end ||
    !/^il_[A-Za-z0-9]+$/.test(line.id) ||
    !/^si_[A-Za-z0-9]+$/.test(line.subscription_item) ||
    !/^price_[A-Za-z0-9]+$/.test(line.price.id) ||
    !/^prod_[A-Za-z0-9]+$/.test(line.price.product) ||
    !Number.isFinite(new Date(event.created * 1000).getTime()) ||
    !Number.isFinite(new Date(line.period.start * 1000).getTime()) ||
    !Number.isFinite(new Date(line.period.end * 1000).getTime())
  )
    unavailable();
  const body = {
    kind: "subscription_invoice_event_observation" as const,
    version: 1 as const,
    scope,
    event,
  };
  return { ...body, digest: settlementDigest(body) };
}

/** Stored evidence must be the exact projection, not a hash alongside arbitrary private fields. */
export function bindSubscriptionInvoiceEventEvidence(
  stored: unknown,
  expected: SubscriptionInvoiceEventScope,
): SubscriptionInvoiceEventEvidence {
  const parsed = bodySchema.extend({ digest: hash }).safeParse(stored);
  if (!parsed.success) unavailable();
  const canonical = createSubscriptionInvoiceEventEvidence(parsed.data.event, expected);
  if (
    canonical.digest !== parsed.data.digest ||
    settlementDigest(stored) !== settlementDigest(canonical)
  )
    unavailable();
  return canonical;
}
