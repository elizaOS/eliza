/** Verified subscription deliveries retain original target evidence; only fresh recovery may publish. */
import { ElizaError } from "@elizaos/core";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { dbWrite } from "../../db/helpers";
import { recordOrganizationUpgradeHistoricalTarget } from "../../db/repositories/organization-upgrade-historical-targets";
import { readOrganizationUpgradeRecoveryContext } from "../../db/repositories/organization-upgrade-recovery-context";
import { recordOrganizationUpgradeRecoveryOutcome } from "../../db/repositories/organization-upgrade-recovery-incidents";
import { billingSubscriptions as sources } from "../../db/schemas/billing-subscriptions";
import { organizationUpgradeInvoiceOrigins as origins } from "../../db/schemas/organization-upgrade-invoice-origins";
import { billingSubscriptionCommands as commands } from "../../db/schemas/subscription-billing-operations";
import type { StripeEventMessage } from "../../types/stripe-queue-message";
import { reconcileOriginalOrganizationUpgrade } from "./organization-upgrade-recovery";

const envelope = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]+$/),
  object: z.literal("event"),
  type: z.enum(["customer.subscription.updated", "customer.subscription.pending_update_applied"]),
  api_version: z.string().nullable(),
  created: z.number().int().positive().safe(),
  livemode: z.boolean(),
  account: z.never().optional(),
  context: z.never().optional(),
  data: z.object({
    object: z
      .object({
        id: z.string().regex(/^sub_[A-Za-z0-9]+$/),
        object: z.literal("subscription"),
        customer: z.string().regex(/^cus_[A-Za-z0-9]+$/),
        livemode: z.boolean(),
        latest_invoice: z
          .string()
          .regex(/^in_[A-Za-z0-9]+$/)
          .nullable(),
      })
      .passthrough(),
  }),
});
const active = z.object({
  status: z.literal("active"),
  cancel_at_period_end: z.literal(false),
  cancel_at: z.null(),
  schedule: z.null(),
  pause_collection: z.null(),
});
function reject(reason: string): never {
  throw new ElizaError("Original upgrade subscription event requires reconciliation", {
    code: "SUBSCRIPTION_UPGRADE_EVENT_UNAVAILABLE",
    context: { reason },
  });
}
/** `live` is a fresh provider routing hint only. The paid finalizer independently retrieves authority. */
export async function reconcileOrganizationUpgradeSubscriptionEvent(
  message: StripeEventMessage,
  live: unknown,
) {
  const parsed = envelope.safeParse(message.event);
  if (!parsed.success) reject("unsupported_subscription_event");
  const event = parsed.data,
    object = event.data.object;
  if (
    message.eventId !== event.id ||
    message.eventType !== event.type ||
    event.livemode !== object.livemode
  )
    reject("queue_identity_mismatch");
  if (!object.latest_invoice) return { owned: false as const };
  const identity = and(
    eq(sources.provider, "stripe"),
    eq(sources.merchant_key, "platform"),
    isNull(sources.billing_scope_id),
    eq(sources.provider_environment, event.livemode ? "live" : "test"),
    eq(sources.stripe_customer_id, object.customer),
    eq(sources.stripe_subscription_id, object.id),
    eq(commands.organization_id, sources.organization_id),
    isNull(commands.app_id),
    isNull(commands.billing_scope_id),
    eq(commands.merchant_key, "platform"),
    eq(commands.kind, "upgrade"),
    eq(commands.organization_upgrade_dispatch_state, "started"),
    inArray(commands.status, ["OUTCOME_UNKNOWN", "APPLIED"]),
  );
  const matches = await dbWrite
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
        eq(origins.invoice_id, object.latest_invoice),
        eq(origins.livemode, event.livemode),
        eq(origins.customer_id, object.customer),
        eq(origins.subscription_id, object.id),
      ),
    )
    .limit(2);
  if (matches.length > 1) reject("ambiguous_original_invoice");
  const original = matches[0];
  if (!original) {
    const [pending] = await dbWrite
      .select({ id: commands.id })
      .from(commands)
      .innerJoin(sources, eq(sources.id, commands.subscription_id))
      .where(and(identity, eq(commands.status, "OUTCOME_UNKNOWN")))
      .limit(1);
    if (pending) reject("original_invoice_receipt_pending");
    return { owned: false as const };
  }
  const context = await readOrganizationUpgradeRecoveryContext(original);
  // Once applied, ordinary updates belong to current lifecycle owners, including plan drift.
  if (context.command.status === "APPLIED" && event.type === "customer.subscription.updated") {
    await recordOrganizationUpgradeRecoveryOutcome({ ...original, issueCode: null });
    return { owned: false as const };
  }
  if (event.api_version !== context.binding.apiVersion)
    reject("unsupported_original_event_version");
  const price = z
    .object({
      items: z.object({ data: z.array(z.object({ price: z.object({ id: z.string() }) })) }),
    })
    .safeParse(object);
  const pending = object.pending_update !== null && object.pending_update !== undefined;
  const oldPrice =
    price.success && price.data.items.data[0]?.price.id === context.binding.sourcePriceId;
  let captured = false;
  if (active.safeParse(object).success && !pending && !oldPrice) {
    await recordOrganizationUpgradeHistoricalTarget({ ...original, raw: message.event });
    captured = true;
  }
  // An applied command must not claim later ordinary updates and hide current plan drift.
  if (context.command.status === "APPLIED") {
    await recordOrganizationUpgradeRecoveryOutcome({ ...original, issueCode: null });
    return { owned: event.type === "customer.subscription.pending_update_applied" && captured };
  }
  // Current cancellation, dunning and terminal observations stay with their existing owners.
  if (!active.safeParse(live).success) return { owned: false as const };
  const outcome = await reconcileOriginalOrganizationUpgrade(original);
  if (outcome.status === "applied")
    await recordOrganizationUpgradeRecoveryOutcome({ ...original, issueCode: null });
  else if (outcome.status === "pending" && outcome.reason === "requires_reconciliation")
    await recordOrganizationUpgradeRecoveryOutcome({
      ...original,
      issueCode: "UPGRADE_INVOICE_REQUIRES_RECONCILIATION",
    });
  return { owned: true as const };
}
