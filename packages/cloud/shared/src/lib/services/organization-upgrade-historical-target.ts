/** Authenticated historical evidence only; never current entitlement authority. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { observeAppliedOrganizationUpgrade } from "./organization-upgrade-target";
import { settlementDigest } from "./settlement-digest";

const eventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]+$/),
  object: z.literal("event"),
  type: z.enum(["customer.subscription.updated", "customer.subscription.pending_update_applied"]),
  api_version: z.literal("2024-11-20.acacia"),
  created: z.number().int().positive().safe(),
  livemode: z.boolean(),
  account: z.never().optional(),
  context: z.never().optional(),
  data: z.object({
    object: z.object({ latest_invoice: z.string().regex(/^in_[A-Za-z0-9]+$/) }).passthrough(),
  }),
});
export function projectHistoricalUpgradeTarget(
  input: Omit<Parameters<typeof observeAppliedOrganizationUpgrade>[0], "raw"> & {
    raw: unknown;
    origin: {
      invoiceId: string;
      customerId: string;
      subscriptionId: string;
      livemode: boolean;
      invoiceCreatedAt: Date;
    };
  },
) {
  const parsed = eventSchema.safeParse(input.raw);
  const reject = (): never => {
    throw new ElizaError("Historical upgrade target evidence unavailable", {
      code: "SUBSCRIPTION_UPGRADE_HISTORICAL_TARGET_UNVERIFIED",
    });
  };
  if (!parsed.success) reject();
  const event = parsed.data!;
  const observed = input.observedAt.getTime();
  const created = event.created * 1000;
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(input.origin.invoiceCreatedAt.getTime()) ||
    created > observed ||
    created < input.origin.invoiceCreatedAt.getTime() ||
    created < input.review.prorationDate * 1000 ||
    created >= (input.source.current_period_end?.getTime() ?? 0) ||
    input.origin.customerId !== input.source.stripe_customer_id ||
    input.origin.subscriptionId !== input.source.stripe_subscription_id ||
    event.livemode !== input.origin.livemode ||
    event.livemode !== input.binding.livemode ||
    event.data.object.latest_invoice !== input.origin.invoiceId
  )
    reject();
  const target = observeAppliedOrganizationUpgrade({
    ...input,
    raw: event.data.object,
    observedAt: new Date(created),
  });
  return {
    apiVersion: event.api_version,
    eventId: event.id,
    eventType: event.type,
    eventCreatedAt: new Date(created),
    invoiceId: input.origin.invoiceId,
    eventDigest: settlementDigest(event),
    target,
    rawSubscription: event.data.object,
  };
}
