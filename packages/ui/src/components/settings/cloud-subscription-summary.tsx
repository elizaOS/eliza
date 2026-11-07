/**
 * Shared account surface for an Eliza Cloud subscription: plan state, the plan
 * allowance Cloud reports, and the most recent Cloud limit with its retry time.
 *
 * The facts come from `@elizaos/cloud-sdk/subscription-entitlement`
 * (`subscriptionSummary`, `serviceLimitNextChange`); this module only renders
 * them. It never reads billing, buys anything or selects a price, quota or
 * limit. Apps theme it through `className`/`classNames` and their own CSS, or
 * keep their own markup and use `useCloudSubscriptionSummary` alone.
 *
 * Re-rendering is driven by the shown limit only: the surface updates when the
 * limit's wait ends or its reset passes, never as a per-second countdown.
 */
import {
  type ServiceLimit,
  type SubscriptionCopy,
  type SubscriptionSummary,
  type SubscriptionView,
  serviceLimitNextChange,
  subscriptionSummary,
} from "@elizaos/cloud-sdk/subscription-entitlement";
import { useEffect, useState } from "react";

/** A Cloud limit together with the time this app observed it. */
export type ObservedServiceLimit = ServiceLimit & { observedAt: number };

export interface CloudSubscriptionSummaryOptions {
  /** End of the plan window when known from another source (for example a redeemed grant). */
  planEndsAt?: number | null;
  /** The most recent Cloud refusal, if any. */
  lastLimit?: ObservedServiceLimit | null;
  /** Product names used in shared copy. */
  copy?: SubscriptionCopy;
}

/**
 * The shared subscription summary for `view`, recomputed when the shown limit
 * lapses or its reset passes so a stale retry time is not left on screen.
 */
export function useCloudSubscriptionSummary(
  view: SubscriptionView | null | undefined,
  options: CloudSubscriptionSummaryOptions = {},
): SubscriptionSummary {
  const { planEndsAt = null, lastLimit = null, copy } = options;
  const [, tick] = useState(0);
  const now = Date.now();
  const summary = subscriptionSummary(view ?? null, {
    planEndsAt,
    lastLimit,
    lastLimitAt: lastLimit?.observedAt ?? null,
    now,
    copy,
  });
  const nextChange =
    summary.limit && lastLimit
      ? serviceLimitNextChange(lastLimit, lastLimit.observedAt, now)
      : null;
  useEffect(() => {
    if (nextChange === null) return;
    const timer = setTimeout(() => tick((value) => value + 1), nextChange);
    return () => clearTimeout(timer);
  });
  return summary;
}

function planEndLabel(endsAt: number, now: number): string {
  const date = new Date(endsAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const days = Math.ceil((endsAt - now) / 86_400_000);
  return days > 0
    ? `Ends ${date} · ${days} ${days === 1 ? "day" : "days"} left`
    : `Ended ${date}`;
}

export interface CloudSubscriptionSummaryProps
  extends CloudSubscriptionSummaryOptions {
  view: SubscriptionView | null | undefined;
  /** Leave out the plan row when the host already shows the plan elsewhere. */
  hidePlan?: boolean;
  /** Label for the plan row. */
  planLabel?: string;
  /** Label for the limit row. */
  limitLabel?: string;
  className?: string;
  classNames?: Partial<
    Record<"plan" | "planDetail" | "allowance" | "limit", string>
  >;
}

/**
 * Plan and limit facts as a definition list. Renders the plan headline with
 * its end date and allowance, and the latest Cloud limit (with retry time) as
 * a live status row. Nothing is rendered for a limit that no longer applies.
 */
export function CloudSubscriptionSummary({
  view,
  hidePlan = false,
  planLabel = "Plan",
  limitLabel = "AI requests",
  className,
  classNames = {},
  ...options
}: CloudSubscriptionSummaryProps) {
  const summary = useCloudSubscriptionSummary(view, options);
  const active = view?.kind === "active";
  const endsAt = summary.planEndsAt;
  return (
    <dl
      className={className ?? "grid gap-3 text-sm"}
      data-cloud-subscription-summary=""
    >
      {!hidePlan && (
        <div className={classNames.plan ?? "flex justify-between gap-3"}>
          <dt className="font-medium">{planLabel}</dt>
          <dd className="m-0 text-end">
            {summary.headline}
            {active && typeof endsAt === "number" && Number.isFinite(endsAt) ? (
              <small
                className={
                  classNames.planDetail ?? "block text-xs text-muted-foreground"
                }
              >
                {planEndLabel(endsAt, Date.now())}
              </small>
            ) : null}
            {summary.allowance ? (
              <small
                className={
                  classNames.allowance ?? "block text-xs text-muted-foreground"
                }
              >
                {summary.allowance}
              </small>
            ) : null}
          </dd>
        </div>
      )}
      {summary.limit ? (
        <div className={classNames.limit ?? "flex justify-between gap-3"}>
          <dt className="font-medium">{limitLabel}</dt>
          <dd className="m-0 text-end" role="status">
            {summary.limit}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
