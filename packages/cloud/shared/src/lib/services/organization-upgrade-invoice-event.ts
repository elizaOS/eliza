/** Routes authenticated original upgrade invoices; event payment status is not finalization authority. */
import { ElizaError } from "@elizaos/core";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { dbWrite } from "../../db/helpers";
import { recordOrganizationUpgradeInvoiceOrigin } from "../../db/repositories/organization-upgrade-invoice-origins";
import { recordOrganizationUpgradeRecoveryOutcome } from "../../db/repositories/organization-upgrade-recovery-incidents";
import { billingSubscriptions as sources } from "../../db/schemas/billing-subscriptions";
import { organizationUpgradeInvoiceOrigins as origins } from "../../db/schemas/organization-upgrade-invoice-origins";
import { billingSubscriptionCommands as commands } from "../../db/schemas/subscription-billing-operations";
import type { StripeEventMessage } from "../../types/stripe-queue-message";
import { reconcileOriginalOrganizationUpgrade } from "./organization-upgrade-recovery";

const eventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]+$/),
  object: z.literal("event"),
  type: z.enum(["invoice.created", "invoice.paid"]),
  api_version: z.literal("2024-11-20.acacia"),
  created: z.number().int().positive().safe(),
  livemode: z.boolean(),
  account: z.never().optional(),
  context: z.never().optional(),
  request: z
    .object({ id: z.string().nullable(), idempotency_key: z.string().nullable() })
    .nullable(),
  data: z.object({
    object: z.object({
      id: z.string().regex(/^in_[A-Za-z0-9]+$/),
      object: z.literal("invoice"),
      customer: z.string().regex(/^cus_[A-Za-z0-9]+$/),
      subscription: z.string().regex(/^sub_[A-Za-z0-9]+$/),
      livemode: z.boolean(),
      billing_reason: z.literal("subscription_update"),
    }),
  }),
});
function reject(reason: string): never {
  throw new ElizaError("Original upgrade invoice event requires reconciliation", {
    code: "SUBSCRIPTION_UPGRADE_EVENT_UNAVAILABLE",
    context: { reason },
  });
}
/** Internal verified queue boundary; never accept a renderer-supplied event. */
export async function reconcileOrganizationUpgradeInvoiceEvent(message: StripeEventMessage) {
  const parsed = eventSchema.safeParse(message.event);
  if (!parsed.success) reject("unsupported_event_authority");
  const event = parsed.data,
    invoice = event.data.object;
  if (
    message.eventId !== event.id ||
    message.eventType !== event.type ||
    event.livemode !== invoice.livemode
  )
    reject("queue_identity_mismatch");
  const identity = and(
    eq(sources.provider, "stripe"),
    eq(sources.merchant_key, "platform"),
    isNull(sources.billing_scope_id),
    eq(sources.provider_environment, event.livemode ? "live" : "test"),
    eq(sources.stripe_customer_id, invoice.customer),
    eq(sources.stripe_subscription_id, invoice.subscription),
    eq(commands.organization_id, sources.organization_id),
    isNull(commands.app_id),
    isNull(commands.billing_scope_id),
    eq(commands.merchant_key, "platform"),
    eq(commands.kind, "upgrade"),
    eq(commands.organization_upgrade_dispatch_state, "started"),
    inArray(commands.status, ["OUTCOME_UNKNOWN", "APPLIED"]),
  );
  // Created events are the only webhook receipt carrying original request attribution.
  if (event.type === "invoice.created") {
    if (!event.request?.idempotency_key) return { owned: false as const };
    const matches = await dbWrite
      .select({ organizationId: commands.organization_id, commandId: commands.id })
      .from(commands)
      .innerJoin(sources, eq(sources.id, commands.subscription_id))
      .where(and(identity, eq(commands.provider_idempotency_key, event.request.idempotency_key)))
      .limit(2);
    if (matches.length > 1) reject("ambiguous_original_command");
    const original = matches[0];
    if (!original) return { owned: false as const };
    await recordOrganizationUpgradeInvoiceOrigin({
      ...original,
      evidence: { kind: "invoice_created_event", raw: message.event },
    });
    // Cron and paid delivery own observation; persisting attribution needs no provider request.
    return { owned: true as const };
  }
  const receipt = await dbWrite
    .select({ organizationId: commands.organization_id, commandId: commands.id })
    .from(commands)
    .innerJoin(sources, eq(sources.id, commands.subscription_id))
    .innerJoin(
      origins,
      and(
        eq(origins.command_id, commands.id),
        eq(origins.organization_id, commands.organization_id),
      ),
    )
    .where(
      and(
        identity,
        eq(origins.invoice_id, invoice.id),
        eq(origins.livemode, event.livemode),
        eq(origins.customer_id, invoice.customer),
        eq(origins.subscription_id, invoice.subscription),
      ),
    )
    .limit(2);
  if (receipt.length > 1) reject("ambiguous_original_invoice");
  const original = receipt[0];
  if (!original) {
    // A paid-before-created delivery must not become a renewal or infer attribution.
    const [pending] = await dbWrite
      .select({ id: commands.id })
      .from(commands)
      .innerJoin(sources, eq(sources.id, commands.subscription_id))
      .where(and(identity, eq(commands.status, "OUTCOME_UNKNOWN")))
      .limit(1);
    if (pending) reject("original_invoice_receipt_pending");
    return { owned: false as const };
  }
  const observed = await reconcileOriginalOrganizationUpgrade(original);
  if (observed.status === "applied")
    await recordOrganizationUpgradeRecoveryOutcome({ ...original, issueCode: null });
  else if (observed.status === "pending" && observed.reason === "requires_reconciliation")
    await recordOrganizationUpgradeRecoveryOutcome({
      ...original,
      issueCode: "UPGRADE_INVOICE_REQUIRES_RECONCILIATION",
    });
  return { owned: true as const };
}
