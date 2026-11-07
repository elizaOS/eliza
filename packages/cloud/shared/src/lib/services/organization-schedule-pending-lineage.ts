/** Proves the original configured source through compatible pending dunning revisions. */
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { renewalUnavailable } from "./stripe-paid-renewal-validation";

const stable = [
  "organization_id",
  "billing_scope_id",
  "merchant_key",
  "provider",
  "provider_environment",
  "stripe_customer_id",
  "stripe_subscription_id",
  "stripe_subscription_item_id",
  "plan_key",
  "pending_plan_key",
  "catalog_version",
  "quantity",
  "cancel_at_period_end",
] as const;
const dates = ["current_period_start", "current_period_end", "canceled_at", "ended_at"] as const;
type State = Pick<
  BillingSubscription,
  | (typeof stable)[number]
  | (typeof dates)[number]
  | "status"
  | "provider_object_digest"
  | "dunning_started_at"
  | "grace_expires_at"
>;
type Source = State & Pick<BillingSubscription, "id" | "lifecycle_revision">;
type Revision = State & { subscription_id: string; revision: number };
function reject(): never {
  return renewalUnavailable("original_pending_schedule_lineage_changed");
}

export function readConfiguredPendingSource<T extends Source>(
  source: T,
  revisions: Revision[],
  configuredRevision: number,
) {
  const configured = revisions[0],
    last = revisions.at(-1);
  if (
    !configured ||
    !last ||
    !Number.isSafeInteger(configuredRevision) ||
    configuredRevision < 2 ||
    !Number.isSafeInteger(source.lifecycle_revision) ||
    revisions.length !== source.lifecycle_revision - configuredRevision + 1 ||
    configured.status !== "active" ||
    configured.dunning_started_at !== null ||
    configured.grace_expires_at !== null ||
    configured.billing_scope_id !== null ||
    configured.merchant_key !== "platform" ||
    configured.provider !== "stripe" ||
    configured.pending_plan_key === null ||
    configured.cancel_at_period_end ||
    configured.ended_at !== null
  )
    reject();
  let dunningStart: number | undefined, graceEnd: number | undefined;
  for (const [index, row] of revisions.entries()) {
    if (row.revision !== configuredRevision + index || row.subscription_id !== source.id) reject();
    for (const key of stable)
      if (row[key] !== configured[key] || row[key] !== source[key]) reject();
    for (const key of dates)
      if (
        row[key]?.getTime() !== configured[key]?.getTime() ||
        row[key]?.getTime() !== source[key]?.getTime()
      )
        reject();
    if (index > 0) {
      if (
        !["grace", "past_due", "unpaid"].includes(row.status) ||
        !row.dunning_started_at ||
        !row.grace_expires_at
      )
        reject();
      const start = row.dunning_started_at.getTime(),
        end = row.grace_expires_at.getTime();
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        start !== configured.current_period_end.getTime() ||
        (dunningStart !== undefined && start !== dunningStart) ||
        (graceEnd !== undefined && end !== graceEnd)
      )
        reject();
      dunningStart = start;
      graceEnd = end;
    }
  }
  if (
    last.status !== source.status ||
    last.provider_object_digest !== source.provider_object_digest ||
    last.dunning_started_at?.getTime() !== source.dunning_started_at?.getTime() ||
    last.grace_expires_at?.getTime() !== source.grace_expires_at?.getTime()
  )
    reject();
  return { ...source, ...configured, id: source.id, lifecycle_revision: configured.revision };
}
