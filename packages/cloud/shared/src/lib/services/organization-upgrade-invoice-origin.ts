/** Pure projection of authenticated original-request evidence; never payment authority. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { settlementDigest } from "./settlement-digest";

const seconds = z.number().int().positive().safe();
const originSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]+$/),
  object: z.literal("event"),
  type: z.literal("invoice.created"),
  api_version: z.literal("2024-11-20.acacia"),
  created: seconds,
  livemode: z.boolean(),
  account: z.never().optional(),
  context: z.never().optional(),
  request: z.object({
    id: z.string().regex(/^req_[A-Za-z0-9]+$/),
    idempotency_key: z.string().min(1),
  }),
  data: z.object({
    object: z.object({
      id: z.string().regex(/^in_[A-Za-z0-9]+$/),
      object: z.literal("invoice"),
      customer: z.string().regex(/^cus_[A-Za-z0-9]+$/),
      subscription: z.string().regex(/^sub_[A-Za-z0-9]+$/),
      livemode: z.boolean(),
      billing_reason: z.literal("subscription_update"),
      currency: z.literal("usd"),
      created: seconds,
    }),
  }),
});
function reject(): never {
  throw new ElizaError("Original upgrade invoice request attribution is unavailable", {
    code: "SUBSCRIPTION_UPGRADE_INVOICE_ORIGIN_UNVERIFIED",
  });
}
/** Caller authenticates via signature verification or platform Stripe event retrieval.
 * A renderer-provided object is never authenticated evidence. A matching price,
 * paid status or latest_invoice is insufficient. Durable storage and final paid
 * validation remain separate and mandatory before changing entitlement/allowance.
 */
export function projectAuthenticatedUpgradeInvoiceOrigin(input: {
  raw: unknown;
  originalRequest: {
    providerIdempotencyKey: string;
    customerId: string;
    subscriptionId: string;
    livemode: boolean;
    prorationDate: number;
  };
  observedAt: Date;
}) {
  const parsed = originSchema.safeParse(input.raw);
  if (!parsed.success) reject();
  const event = parsed.data,
    invoice = event.data.object,
    original = input.originalRequest;
  const observed = Math.floor(input.observedAt.getTime() / 1000);
  if (
    !Number.isSafeInteger(observed) ||
    !Number.isSafeInteger(original.prorationDate) ||
    original.prorationDate <= 0 ||
    event.request.idempotency_key !== original.providerIdempotencyKey ||
    invoice.customer !== original.customerId ||
    invoice.subscription !== original.subscriptionId ||
    event.livemode !== original.livemode ||
    invoice.livemode !== original.livemode ||
    invoice.created < original.prorationDate ||
    event.created < invoice.created ||
    event.created > observed
  )
    reject();
  return {
    kind: "invoice_created_event" as const,
    eventId: event.id,
    providerRequestId: event.request.id,
    invoiceId: invoice.id,
    customerId: invoice.customer,
    subscriptionId: invoice.subscription,
    livemode: invoice.livemode,
    apiVersion: event.api_version,
    eventCreatedAt: new Date(event.created * 1000).toISOString(),
    invoiceCreatedAt: new Date(invoice.created * 1000).toISOString(),
    providerIdempotencyKey: event.request.idempotency_key,
    evidenceDigest: settlementDigest(event),
  };
}

/** Only the result of the original subscriptions.update call may enter here.
 * A subsequent retrieve response lacks its original POST idempotency attribution.
 * Missing transport metadata retains outcome unknown for event-based recovery.
 */
export function projectOriginalUpgradeResponseInvoiceOrigin(
  input: Parameters<typeof projectAuthenticatedUpgradeInvoiceOrigin>[0],
) {
  const invoiceSchema = originSchema.shape.data.shape.object;
  const parsed = z
    .object({
      id: z.string(),
      object: z.literal("subscription"),
      customer: z.string(),
      livemode: z.boolean(),
      latest_invoice: invoiceSchema,
      lastResponse: z.object({
        requestId: z.string().regex(/^req_[A-Za-z0-9]+$/),
        statusCode: z.literal(200),
        apiVersion: z.literal("2024-11-20.acacia"),
        idempotencyKey: z.string().min(1),
        stripeAccount: z.never().optional(),
      }),
    })
    .safeParse(input.raw);
  if (!parsed.success) reject();
  const response = parsed.data,
    invoice = response.latest_invoice,
    original = input.originalRequest;
  const observed = Math.floor(input.observedAt.getTime() / 1000);
  if (
    !Number.isSafeInteger(observed) ||
    !Number.isSafeInteger(original.prorationDate) ||
    original.prorationDate <= 0 ||
    response.id !== original.subscriptionId ||
    response.customer !== original.customerId ||
    response.livemode !== original.livemode ||
    response.lastResponse.idempotencyKey !== original.providerIdempotencyKey ||
    invoice.subscription !== original.subscriptionId ||
    invoice.customer !== original.customerId ||
    invoice.livemode !== original.livemode ||
    invoice.created < original.prorationDate ||
    invoice.created > observed
  )
    reject();
  return {
    kind: "update_response" as const,
    eventId: null,
    eventCreatedAt: null,
    providerRequestId: response.lastResponse.requestId,
    invoiceId: invoice.id,
    customerId: invoice.customer,
    subscriptionId: invoice.subscription,
    livemode: invoice.livemode,
    apiVersion: response.lastResponse.apiVersion,
    invoiceCreatedAt: new Date(invoice.created * 1000).toISOString(),
    providerIdempotencyKey: response.lastResponse.idempotencyKey,
    evidenceDigest: settlementDigest(response),
  };
}
