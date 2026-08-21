/** Read-only active compute costs from the canonical billing snapshot v2. */

"use client";

import type { Observed } from "@elizaos/cloud-shared/types/account-billing-snapshot";
import { BrandCard, Button } from "@elizaos/ui/cloud-ui";
import {
  AlertCircle,
  Box,
  Calculator,
  Clock3,
  RefreshCw,
  ServerCog,
} from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "../../../components/ui/skeleton";
import { StatusBadge } from "../../../components/ui/status-badge";
import { useCloudT } from "../../shell/CloudI18nProvider";
import type {
  BillingSnapshotResource,
  BillingSnapshotV2View,
} from "../data/billing-snapshot";
import { formatExactUsd } from "../lib/format-exact-usd";

export type BillingSnapshotViewState =
  | { kind: "loading" }
  | { kind: "paused" }
  | { kind: "error"; retrying: boolean }
  | {
      kind: "ready";
      snapshot: BillingSnapshotV2View;
      refreshing: boolean;
      refreshPaused: boolean;
      refreshFailed: boolean;
    };

interface ActiveComputeCardProps {
  state: BillingSnapshotViewState;
  onRetry: () => void;
}

type Translator = ReturnType<typeof useCloudT>;

function observedTimestamp(value: string): string {
  return value
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC")
    .replace(/Z$/, " UTC");
}

function observationLabel<T>(observation: Observed<T>, t: Translator): string {
  if (observation.status === "available") return "";
  if (observation.status === "unknown_policy") {
    return t("cloud.billing.compute.pendingPolicy", {
      defaultValue: "Pending policy",
    });
  }
  if (observation.status === "not_applicable") {
    return t("cloud.billing.compute.notApplicable", {
      defaultValue: "Not applicable",
    });
  }
  return t("cloud.billing.compute.unavailable", {
    defaultValue: "Unavailable",
  });
}

function exactAmount(
  observation:
    | BillingSnapshotResource["ratePerHour"]
    | BillingSnapshotResource["estimatedRecurringComputeCostPerDay"],
  suffix: string,
  t: Translator,
): ReactNode {
  if (observation.status !== "available") {
    return observationLabel(observation, t);
  }
  return (
    <span className="font-mono tabular-nums">
      {formatExactUsd(observation.value.value)}
      <span className="ml-1 text-muted-strong">{suffix}</span>
    </span>
  );
}

function canRetryObservation<T>(observation: Observed<T>): boolean {
  return (
    observation.status === "unavailable" && observation.error.retryable === true
  );
}

function ResourceCard({
  resource,
  t,
}: {
  resource: BillingSnapshotResource;
  t: Translator;
}) {
  const ResourceIcon = resource.resourceType === "container" ? Box : ServerCog;
  const typeLabel =
    resource.resourceType === "container"
      ? t("cloud.billing.compute.container", { defaultValue: "Container" })
      : t("cloud.billing.compute.agentSandbox", {
          defaultValue: "Agent sandbox",
        });

  return (
    <li className="min-w-0 border border-brand-surface bg-surface p-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 shrink-0 border border-border bg-bg-accent p-2 text-muted-strong">
          <ResourceIcon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="break-words font-mono text-sm font-semibold text-txt-strong [overflow-wrap:anywhere]">
            {resource.name}
          </p>
          <p className="mt-1 break-words font-mono text-xs text-muted-strong [overflow-wrap:anywhere]">
            {typeLabel} · {resource.resourceId}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <StatusBadge
          status="muted"
          className="max-w-full whitespace-normal break-words"
          label={t("cloud.billing.compute.lifecycleStatus", {
            status: resource.status,
            defaultValue: "Lifecycle: {{status}}",
          })}
        />
        <StatusBadge
          status="info"
          className="max-w-full whitespace-normal break-words"
          label={t("cloud.billing.compute.billingStatus", {
            status: resource.billingStatus,
            defaultValue: "Billing: {{status}}",
          })}
        />
      </div>

      <dl className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-strong">
            {t("cloud.billing.compute.rate", { defaultValue: "Rate" })}
          </dt>
          <dd className="mt-1 break-words text-sm text-txt-strong [overflow-wrap:anywhere]">
            {exactAmount(
              resource.ratePerHour,
              t("cloud.billing.compute.perHour", { defaultValue: "/ hour" }),
              t,
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-strong">
            {t("cloud.billing.compute.estimatedRecurring", {
              defaultValue: "Estimated recurring",
            })}
          </dt>
          <dd className="mt-1 break-words text-sm text-txt-strong [overflow-wrap:anywhere]">
            {exactAmount(
              resource.estimatedRecurringComputeCostPerDay,
              t("cloud.billing.compute.perDay", { defaultValue: "/ day" }),
              t,
            )}
          </dd>
        </div>
      </dl>
    </li>
  );
}

function RetryButton({
  onRetry,
  retrying,
  t,
}: {
  onRetry: () => void;
  retrying: boolean;
  t: Translator;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onRetry}
      disabled={retrying}
      className="min-h-11 min-w-11 gap-2 font-mono"
    >
      <RefreshCw
        className={`h-4 w-4 motion-reduce:animate-none ${retrying ? "animate-spin" : ""}`}
        aria-hidden="true"
      />
      {retrying
        ? t("cloud.billing.compute.retrying", { defaultValue: "Retrying…" })
        : t("cloud.billing.compute.retry", { defaultValue: "Retry" })}
    </Button>
  );
}

function LoadingCard({ t }: { t: Translator }) {
  return (
    <BrandCard
      cornerSize="sm"
      role="status"
      aria-busy="true"
      aria-label={t("cloud.billing.compute.loading", {
        defaultValue: "Loading active compute",
      })}
    >
      <div className="relative z-10 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-5 w-36 motion-reduce:animate-none" />
            <Skeleton className="h-3 w-64 max-w-full motion-reduce:animate-none" />
          </div>
          <Skeleton className="h-8 w-28 motion-reduce:animate-none" />
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Skeleton className="h-40 w-full motion-reduce:animate-none" />
          <Skeleton className="h-40 w-full motion-reduce:animate-none" />
        </div>
      </div>
    </BrandCard>
  );
}

/** Pure, storyable view for one billing-snapshot query state. */
export function ActiveComputeCardView({
  state,
  onRetry,
}: ActiveComputeCardProps) {
  const t = useCloudT();

  if (state.kind === "loading") return <LoadingCard t={t} />;

  if (state.kind === "paused" || state.kind === "error") {
    const paused = state.kind === "paused";
    const retrying = state.kind === "error" && state.retrying;
    return (
      <BrandCard cornerSize="sm">
        <div className="relative z-10 flex flex-col items-start gap-4 sm:flex-row sm:justify-between">
          <div role="alert" className="flex min-w-0 items-start gap-3">
            <AlertCircle
              className="mt-0.5 h-5 w-5 shrink-0 text-warn"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <h3 className="font-mono text-base uppercase text-txt-strong">
                {paused
                  ? t("cloud.billing.compute.waitingConnection", {
                      defaultValue: "Waiting for a connection",
                    })
                  : t("cloud.billing.compute.loadError", {
                      defaultValue: "Active compute unavailable",
                    })}
              </h3>
              <p className="mt-1 text-sm text-muted-strong">
                {paused
                  ? t("cloud.billing.compute.waitingConnectionDetail", {
                      defaultValue:
                        "The request will resume when a connection is available.",
                    })
                  : t("cloud.billing.compute.loadErrorDetail", {
                      defaultValue:
                        "The current snapshot could not be loaded. No fallback costs are shown.",
                    })}
              </p>
            </div>
          </div>
          {!paused ? (
            <RetryButton onRetry={onRetry} retrying={retrying} t={t} />
          ) : null}
        </div>
      </BrandCard>
    );
  }

  const { snapshot } = state;
  const resourcesObservation = snapshot.activeCompute.resources;
  const totalObservation =
    snapshot.activeCompute.estimatedRecurringComputeCostPerDay;
  const resources =
    resourcesObservation.status === "available"
      ? resourcesObservation.value
      : null;
  const hasPartialCost =
    totalObservation.status !== "available" ||
    (resources?.some(
      (resource) =>
        resource.ratePerHour.status !== "available" ||
        resource.estimatedRecurringComputeCostPerDay.status !== "available",
    ) ??
      false);
  const retryablePartial =
    canRetryObservation(totalObservation) ||
    (resources?.some(
      (resource) =>
        canRetryObservation(resource.ratePerHour) ||
        canRetryObservation(resource.estimatedRecurringComputeCostPerDay),
    ) ??
      false);
  const accessibilityStatus =
    state.refreshPaused || state.refreshFailed
      ? null
      : state.refreshing
        ? t("cloud.billing.compute.refreshingAnnouncement", {
            defaultValue: "Refreshing active compute.",
          })
        : resourcesObservation.status !== "available"
          ? `${observationLabel(resourcesObservation, t)}. ${t(
              "cloud.billing.compute.resourcesUnavailableDetail",
              {
                defaultValue:
                  "Active resources cannot be shown from this observation. No empty state is inferred.",
              },
            )}`
          : hasPartialCost
            ? t("cloud.billing.compute.partial", {
                defaultValue:
                  "Some cost observations are unavailable. No estimate is recalculated in the client.",
              })
            : t("cloud.billing.compute.ready", {
                defaultValue: "Active compute snapshot ready.",
              });

  return (
    <BrandCard cornerSize="sm" aria-busy={state.refreshing || undefined}>
      <div className="relative z-10 space-y-5">
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {accessibilityStatus ?? ""}
        </p>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Calculator
                className="h-4 w-4 shrink-0 text-muted-strong"
                aria-hidden="true"
              />
              <h3 className="font-mono text-base uppercase text-txt-strong">
                {t("cloud.billing.compute.title", {
                  defaultValue: "Active compute",
                })}
              </h3>
              {state.refreshing ? (
                <StatusBadge
                  status="info"
                  label={t("cloud.billing.compute.refreshing", {
                    defaultValue: "Refreshing",
                  })}
                  icon={
                    <RefreshCw
                      className="animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  }
                />
              ) : null}
            </div>
            <p className="mt-2 max-w-2xl text-sm text-muted-strong">
              {t("cloud.billing.compute.description", {
                defaultValue:
                  "Server-observed billable containers and agent sandboxes.",
              })}
            </p>
          </div>

          <div className="min-w-0 text-left sm:max-w-[50%] sm:text-right">
            <p className="text-xs uppercase tracking-wide text-muted-strong">
              {t("cloud.billing.compute.totalPerDay", {
                defaultValue: "Estimated total / day",
              })}
            </p>
            <p className="mt-1 break-words font-mono text-xl text-txt-strong tabular-nums [overflow-wrap:anywhere]">
              {totalObservation.status === "available"
                ? formatExactUsd(totalObservation.value.value)
                : observationLabel(totalObservation, t)}
            </p>
          </div>
        </div>

        {state.refreshFailed || state.refreshPaused ? (
          <div
            role="alert"
            className="flex flex-col gap-3 border border-warn/40 bg-warn/10 p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 items-start gap-2 text-sm text-txt">
              <Clock3
                className="mt-0.5 h-4 w-4 shrink-0 text-warn"
                aria-hidden="true"
              />
              <span>
                {state.refreshPaused
                  ? t("cloud.billing.compute.refreshPaused", {
                      completedAt: observedTimestamp(
                        snapshot.snapshotCompletedAt,
                      ),
                      defaultValue:
                        "Refresh paused. Showing the snapshot completed at {{completedAt}}.",
                    })
                  : t("cloud.billing.compute.refreshFailed", {
                      completedAt: observedTimestamp(
                        snapshot.snapshotCompletedAt,
                      ),
                      defaultValue:
                        "Could not refresh. Showing the snapshot completed at {{completedAt}}.",
                    })}
              </span>
            </div>
            {!state.refreshPaused ? (
              <RetryButton
                onRetry={onRetry}
                retrying={state.refreshing}
                t={t}
              />
            ) : null}
          </div>
        ) : (
          <p className="text-xs font-mono text-muted">
            {t("cloud.billing.compute.observedAt", {
              observedAt: observedTimestamp(totalObservation.observedAt),
              defaultValue: "Observed {{observedAt}}",
            })}
          </p>
        )}

        {resourcesObservation.status === "available" ? (
          resourcesObservation.value.length === 0 ? (
            <div className="border border-brand-surface bg-surface px-4 py-8 text-center">
              <p className="font-mono text-sm text-txt-strong">
                {t("cloud.billing.compute.empty", {
                  defaultValue: "No active billable compute",
                })}
              </p>
              <p className="mt-1 text-sm text-muted-strong">
                {t("cloud.billing.compute.emptyDetail", {
                  defaultValue:
                    "No containers or agent sandboxes are currently reported as billable.",
                })}
              </p>
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {resourcesObservation.value.map((resource) => (
                <ResourceCard
                  key={`${resource.resourceType}:${resource.resourceId}`}
                  resource={resource}
                  t={t}
                />
              ))}
            </ul>
          )
        ) : (
          <div className="flex flex-col items-start gap-4 border border-brand-surface bg-surface p-4 sm:flex-row sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <AlertCircle
                className="mt-0.5 h-4 w-4 shrink-0 text-warn"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="font-mono text-sm text-txt-strong">
                  {observationLabel(resourcesObservation, t)}
                </p>
                <p className="mt-1 text-sm text-muted-strong">
                  {t("cloud.billing.compute.resourcesUnavailableDetail", {
                    defaultValue:
                      "Active resources cannot be shown from this observation. No empty state is inferred.",
                  })}
                </p>
              </div>
            </div>
            {canRetryObservation(resourcesObservation) ? (
              <RetryButton
                onRetry={onRetry}
                retrying={state.refreshing}
                t={t}
              />
            ) : null}
          </div>
        )}

        {resourcesObservation.status === "available" && hasPartialCost ? (
          <div className="flex flex-col items-start gap-3 border border-warn/40 bg-warn/10 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-2 text-sm text-txt">
              <AlertCircle
                className="mt-0.5 h-4 w-4 shrink-0 text-warn"
                aria-hidden="true"
              />
              <span>
                {t("cloud.billing.compute.partial", {
                  defaultValue:
                    "Some cost observations are unavailable. No estimate is recalculated in the client.",
                })}
              </span>
            </div>
            {retryablePartial ? (
              <RetryButton
                onRetry={onRetry}
                retrying={state.refreshing}
                t={t}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </BrandCard>
  );
}
