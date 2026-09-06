/** Validates complete terminal lifecycle observations against locked receipt and organization authority, without deciding trial, invoice or allowance policy. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type { BillingSubscription } from "../schemas/billing-subscriptions";
import type { BillingSubscriptionEventReceipt } from "../schemas/subscription-billing-operations";

export const SUBSCRIPTION_LIFECYCLE_UNSUPPORTED = "SUBSCRIPTION_LIFECYCLE_UNSUPPORTED";
export const SUBSCRIPTION_LIFECYCLE_REOBSERVE = "SUBSCRIPTION_LIFECYCLE_REOBSERVE";
export const SUBSCRIPTION_LIFECYCLE_LEASE_LOST = "SUBSCRIPTION_LIFECYCLE_LEASE_LOST";
export const TERMINAL_LIFECYCLE_DISPOSITION = "terminal_lifecycle_finalized";

const terminalObservationSchema = z
  .object({
    provider: z.literal("stripe"),
    provider_environment: z.enum(["test", "live"]),
    stripe_customer_id: z.string().min(1),
    stripe_subscription_id: z.string().min(1),
    stripe_subscription_item_id: z.string().min(1),
    catalog_version: z.string().min(1),
    plan_key: z.enum(["plus_monthly", "pro_monthly"]),
    status: z.enum(["canceled", "incomplete_expired"]),
    current_period_start: z.date(),
    current_period_end: z.date(),
    cancel_at_period_end: z.boolean(),
    canceled_at: z.date().nullable(),
    ended_at: z.date().nullable(),
    dunning_started_at: z.date().nullable(),
    grace_expires_at: z.date().nullable(),
    pending_plan_key: z.enum(["plus_monthly", "pro_monthly"]).nullable(),
    last_provider_event_id: z.string().min(1),
    last_provider_event_created_at: z.date(),
    provider_object_digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export function lifecycleFailure(
  code: string,
  message: string,
  context: Record<string, unknown>,
): never {
  throw new ElizaError(message, { code, context });
}

export function parseTerminalLifecycleObservation(observation: unknown) {
  const parsed = terminalObservationSchema.safeParse(observation);
  if (!parsed.success) {
    lifecycleFailure(
      SUBSCRIPTION_LIFECYCLE_UNSUPPORTED,
      "Observation requires unsupported lifecycle policy or has invalid fields",
      {
        fields: parsed.error.issues.map((issue) => issue.path.join(".")),
      },
    );
  }
  return parsed.data;
}

type TerminalObservation = z.infer<typeof terminalObservationSchema>;

export function validateTerminalReceipt(
  receipt: BillingSubscriptionEventReceipt,
  values: TerminalObservation,
): void {
  if (
    receipt.provider_object_type !== "subscription" ||
    !["customer.subscription.updated", "customer.subscription.deleted"].includes(
      receipt.event_type,
    ) ||
    receipt.provider_object_id !== values.stripe_subscription_id ||
    receipt.provider_event_id !== values.last_provider_event_id ||
    receipt.livemode !== (values.provider_environment === "live") ||
    receipt.event_created_at.getTime() !== values.last_provider_event_created_at.getTime()
  ) {
    lifecycleFailure(
      SUBSCRIPTION_LIFECYCLE_UNSUPPORTED,
      "Receipt does not match supported subscription provider authority",
      { receiptId: receipt.id },
    );
  }
}

export function validateTerminalSource(
  current: BillingSubscription,
  organizationCustomerId: string | null,
  values: TerminalObservation,
): void {
  if (organizationCustomerId === null || organizationCustomerId !== values.stripe_customer_id) {
    lifecycleFailure(
      SUBSCRIPTION_LIFECYCLE_UNSUPPORTED,
      "Organization customer authority must be established before finalization",
      { organizationId: current.organization_id },
    );
  }
  for (const field of [
    "provider",
    "provider_environment",
    "stripe_customer_id",
    "stripe_subscription_id",
    "stripe_subscription_item_id",
    "catalog_version",
    "plan_key",
    "current_period_start",
    "current_period_end",
  ] as const) {
    const stored = current[field];
    const observed = values[field];
    const same =
      stored instanceof Date && observed instanceof Date
        ? stored.getTime() === observed.getTime()
        : stored === observed;
    if (!same) {
      lifecycleFailure(
        SUBSCRIPTION_LIFECYCLE_UNSUPPORTED,
        "Observation changes provider, plan or period authority outside this finalizer",
        { subscriptionId: current.id, field },
      );
    }
  }
  if (
    values.current_period_end <= values.current_period_start ||
    (values.status === "incomplete_expired" &&
      !["pending", "incomplete", "incomplete_expired"].includes(current.status)) ||
    (["canceled", "incomplete_expired"].includes(current.status) &&
      values.status !== current.status)
  ) {
    lifecycleFailure(
      SUBSCRIPTION_LIFECYCLE_UNSUPPORTED,
      "Unsupported terminal subscription transition",
      { from: current.status, to: values.status },
    );
  }
}

/** Event identity alone cannot establish that a replay represents this observation. */
export function validateTerminalPublication(
  current: BillingSubscription,
  values: TerminalObservation,
): void {
  for (const field of terminalObservationSchema.keyof().options) {
    const stored = current[field];
    const observed = values[field];
    const same =
      stored instanceof Date && observed instanceof Date
        ? stored.getTime() === observed.getTime()
        : stored === observed;
    if (!same) {
      lifecycleFailure(
        SUBSCRIPTION_LIFECYCLE_REOBSERVE,
        "Recorded lifecycle differs from the terminal observation; retrieve provider state again",
        { subscriptionId: current.id, field },
      );
    }
  }
}
