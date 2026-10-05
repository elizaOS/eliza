/** Shared pinned Acacia organization subscription shape. Callers validate ownership, catalog and effect authority. */
import { z } from "zod";

const seconds = z.number().int().nonnegative().safe();
export const organizationSubscriptionObservationSchema = z.object({
  id: z.string(),
  object: z.literal("subscription"),
  livemode: z.boolean(),
  customer: z.string(),
  status: z.literal("active"),
  current_period_start: seconds,
  current_period_end: seconds,
  cancel_at_period_end: z.boolean(),
  cancel_at: seconds.nullable(),
  canceled_at: seconds.nullable(),
  ended_at: z.null(),
  trial_start: seconds.nullable(),
  trial_end: seconds.nullable(),
  on_behalf_of: z.null(),
  transfer_data: z.null(),
  application_fee_percent: z.null(),
  schedule: z.null(),
  pending_update: z.null(),
  pause_collection: z.null(),
  items: z.object({
    has_more: z.literal(false),
    data: z
      .array(
        z.object({
          id: z.string(),
          object: z.literal("subscription_item"),
          quantity: z.literal(1),
          price: z.object({
            id: z.string(),
            product: z.string(),
            livemode: z.boolean(),
            currency: z.literal("usd"),
            unit_amount: z.number().int(),
            type: z.literal("recurring"),
            billing_scheme: z.literal("per_unit"),
            transform_quantity: z.null(),
            recurring: z.object({
              interval: z.literal("month"),
              interval_count: z.literal(1),
              usage_type: z.literal("licensed"),
              trial_period_days: z.null(),
            }),
          }),
        }),
      )
      .length(1),
  }),
});
