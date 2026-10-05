/** Routes signature-verified Acacia events to durable merchant bindings without trusting event metadata as authority. */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { dbWrite } from "../../db/helpers";
import { appBillingProviderBindings } from "../../db/repositories/app-billing-provider-bindings";
import { billingMerchants } from "../../db/schemas/app-billing";
import { billingSubscriptionCommands } from "../../db/schemas/subscription-billing-operations";
import type { AppBillingWebhookTrigger } from "../../types/app-billing-webhook";
import { GENERIC_BILLING_STRIPE_API_VERSION } from "./generic-billing-provider-types";

const objectId = z
  .union([z.string().min(1), z.object({ id: z.string().min(1) })])
  .nullable()
  .optional()
  .transform((value) => (typeof value === "string" ? value : (value?.id ?? null)));
const eventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  created: z.number().int().positive(),
  api_version: z.string().nullable(),
  account: z.string().optional(),
  livemode: z.boolean(),
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      object: z.string().min(1),
      mode: z.string().optional(),
      subscription: objectId,
      customer: objectId,
      metadata: z.record(z.string(), z.string()).nullish(),
    }),
  }),
});
/** Call only after SDK signature verification; the body digest retains exact signed bytes. */
export async function appBillingTriggerFromVerifiedEvent(
  raw: unknown,
  signedBody: string,
): Promise<{ receiptKey: string; trigger: AppBillingWebhookTrigger } | null> {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) return null;
  const event = parsed.data,
    object = event.data.object;
  if (
    !(
      object.object === "subscription" ||
      object.object === "invoice" ||
      (object.object === "checkout.session" &&
        (object.mode === "subscription" || object.mode === "setup"))
    )
  )
    return null;
  const merchantKey = event.account ?? "platform";
  const [merchant] = await dbWrite
    .select()
    .from(billingMerchants)
    .where(
      and(
        eq(billingMerchants.provider_account_key, merchantKey),
        eq(billingMerchants.livemode, event.livemode),
      ),
    );
  if (!merchant) return null;
  // The registered platform account ID is needed even though Stripe omits event.account.
  const accountId = merchantKey === "platform" ? merchant.stripe_account_id : merchantKey;
  if (!accountId) return null;
  const bindingInput = {
    merchantId: merchant.id,
    providerAccountId: accountId,
    livemode: event.livemode,
  };
  const subscriptionId = object.object === "subscription" ? object.id : object.subscription;
  const binding = subscriptionId
    ? await appBillingProviderBindings.resolveBinding({
        ...bindingInput,
        objectType: "subscription",
        objectId: subscriptionId,
      })
    : null;
  const customerBinding = object.customer
    ? await appBillingProviderBindings.resolveBinding({
        ...bindingInput,
        objectType: "customer",
        objectId: object.customer,
      })
    : null;
  const commandId = object.metadata?.eliza_command_id;
  const [command] =
    commandId && z.string().uuid().safeParse(commandId).success
      ? await dbWrite
          .select({ id: billingSubscriptionCommands.id })
          .from(billingSubscriptionCommands)
          .where(
            and(
              eq(billingSubscriptionCommands.id, commandId),
              eq(billingSubscriptionCommands.merchant_id, merchant.id),
              eq(billingSubscriptionCommands.livemode, event.livemode),
              eq(
                billingSubscriptionCommands.request_digest,
                object.metadata?.eliza_request_digest ?? "",
              ),
            ),
          )
      : [];
  // Other platform products keep their existing webhook behavior and do not create app recovery work.
  if (!binding && !customerBinding && !command) return null;
  if (event.api_version !== GENERIC_BILLING_STRIPE_API_VERSION)
    throw new ElizaError("App billing webhook version differs from the supported Acacia contract", {
      code: "APP_BILLING_WEBHOOK_VERSION",
    });
  const trigger: AppBillingWebhookTrigger = {
    merchantKey,
    event: {
      eventId: event.id,
      eventType: event.type,
      createdAt: event.created,
      apiVersion: GENERIC_BILLING_STRIPE_API_VERSION,
      merchantId: merchant.id,
      providerAccountId: accountId,
      livemode: event.livemode,
      objectId: object.id,
      objectType: object.object,
      payloadDigest: createHash("sha256").update(signedBody).digest("hex"),
    },
    subscriptionIdHint: object.object === "subscription" ? object.id : object.subscription,
    customerIdHint: object.customer,
    commandIdHint: object.metadata?.eliza_command_id ?? null,
    requestDigestHint: object.metadata?.eliza_request_digest ?? null,
  };
  return {
    receiptKey: `stripe:${merchantKey}:${event.livemode ? "live" : "test"}:${event.id}`,
    trigger,
  };
}
