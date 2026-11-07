/** Fresh later-period compatibility is separate from historical applied-target evidence. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { projectHistoricalUpgradeTarget } from "./organization-upgrade-historical-target";
import { settlementDigest } from "./settlement-digest";
import { organizationSubscriptionObservationSchema } from "./stripe-organization-subscription-observation";
export function observeLaterPeriodUpgrade(
  input: Parameters<typeof projectHistoricalUpgradeTarget>[0] & { live: unknown },
) {
  const evidence = projectHistoricalUpgradeTarget(input);
  const parsed = organizationSubscriptionObservationSchema
    .extend({ collection_method: z.literal("charge_automatically") })
    .safeParse(input.live);
  const reject = (): never => {
    throw new ElizaError("Later-period live subscription is not compatible with original upgrade", {
      code: "SUBSCRIPTION_UPGRADE_LATER_PERIOD_UNVERIFIED",
    });
  };
  if (!parsed.success) reject();
  const live = parsed.data!;
  const item = live.items.data[0]!;
  const now = input.observedAt.getTime();
  if (
    live.id !== input.source.stripe_subscription_id ||
    live.customer !== input.source.stripe_customer_id ||
    live.livemode !== input.binding.livemode ||
    item.id !== input.source.stripe_subscription_item_id ||
    item.price.id !== input.binding.targetPriceId ||
    item.price.product !== input.binding.targetProductId ||
    item.price.livemode !== input.binding.livemode ||
    item.price.unit_amount !== input.review.targetBaseAmountCents ||
    live.current_period_start * 1000 < input.source.current_period_end.getTime() ||
    live.current_period_start * 1000 > now ||
    live.current_period_end * 1000 <= now ||
    live.current_period_end <= live.current_period_start ||
    live.cancel_at_period_end ||
    live.cancel_at !== null ||
    (live.canceled_at !== null &&
      live.canceled_at * 1000 !== input.source.canceled_at?.getTime()) ||
    (live.trial_end !== null && live.trial_end * 1000 > now)
  )
    reject();
  return {
    historical: evidence,
    liveDigest: settlementDigest(live),
    livePeriodStart: new Date(live.current_period_start * 1000),
    livePeriodEnd: new Date(live.current_period_end * 1000),
  };
}
