/** Active compute costs and server-projected controls from billing snapshot v2. */

"use client";

import type { Observed } from "@elizaos/cloud-sdk/account-billing-snapshot";
import { Button, CornerBrackets } from "@elizaos/ui/cloud-ui";
import {
  AlertCircle,
  Box,
  Calculator,
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
  ServerCog,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Alert } from "../../../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Card } from "../../../components/ui/card";
import { Skeleton } from "../../../components/ui/skeleton";
import { StatusBadge } from "../../../components/ui/status-badge";
import { useCloudT } from "../../shell/CloudI18nProvider";
import type {
  BillingSnapshotResource,
  BillingSnapshotV2View,
} from "../data/billing-snapshot";
import {
  type ActiveComputeCancellationViewState,
  billingCancellationIdentityKey,
} from "../lib/billing-resource-cancellation-view";
import { formatExactUsd } from "../lib/format-exact-usd";

export type { ActiveComputeCancellationViewState } from "../lib/billing-resource-cancellation-view";
export { billingCancellationIdentityKey } from "../lib/billing-resource-cancellation-view";

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
  /** Exact authenticated authority; rotates resource-local dialog state. */
  cancellationAuthorityKey?: string;
  cancellationStates?: Readonly<
    Record<string, ActiveComputeCancellationViewState>
  >;
  onRequestCancellation?: (resource: BillingSnapshotResource) => void;
  onCheckCancellationReceipt?: (resource: BillingSnapshotResource) => void;
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

function billingIntervalLabel(
  interval: BillingSnapshotResource["billingInterval"],
  t: Translator,
): string {
  return interval === "hour"
    ? t("cloud.billing.compute.hourly", { defaultValue: "Hourly" })
    : t("cloud.billing.compute.daily", { defaultValue: "Daily" });
}

function billingCursorLabel(value: string | null, emptyLabel: string): string {
  return value === null ? emptyLabel : observedTimestamp(value);
}

function ResourceCard({
  resource,
  t,
  cancellationAuthorityKey,
  cancellationState,
  onRequestCancellation,
  onCheckCancellationReceipt,
}: {
  resource: BillingSnapshotResource;
  t: Translator;
  cancellationAuthorityKey: string;
  cancellationState: ActiveComputeCancellationViewState | undefined;
  onRequestCancellation?: (resource: BillingSnapshotResource) => void;
  onCheckCancellationReceipt?: (resource: BillingSnapshotResource) => void;
}) {
  const cancellationStatusRef = useRef<HTMLDivElement>(null);
  const cancellationBlockerRef = useRef<HTMLDivElement>(null);
  const cancellationTriggerRef = useRef<HTMLButtonElement>(null);
  const submittedFromDialogRef = useRef(false);
  const cancellationDialogWasOpenRef = useRef(false);
  const openedCancellationSignatureRef = useRef<string | null>(null);
  const pendingDialogFocusRef = useRef(false);
  const [cancellationDialogOpen, setCancellationDialogOpen] = useState(false);
  const ResourceIcon = resource.resourceType === "container" ? Box : ServerCog;
  const typeLabel =
    resource.resourceType === "container"
      ? t("cloud.billing.compute.container", { defaultValue: "Container" })
      : t("cloud.billing.compute.agentSandbox", {
          defaultValue: "Agent sandbox",
        });
  const control = resource.cancellationControl;
  const isAgent = resource.resourceType === "agent_sandbox";
  const actionLabel = isAgent
    ? t("cloud.billing.compute.cancel.suspend", {
        defaultValue: "Stop compute",
      })
    : t("cloud.billing.compute.cancel.stop", { defaultValue: "Stop" });
  const canOfferCancellation =
    cancellationState === undefined ||
    cancellationState.kind === "ambiguous" ||
    cancellationState.kind === "rejected";
  const isRetry =
    cancellationState?.kind === "ambiguous" ||
    cancellationState?.kind === "rejected";
  const canSubmit =
    control.eligible &&
    onRequestCancellation !== undefined &&
    canOfferCancellation;
  const cancellationAuthoritySignature = `${cancellationAuthorityKey}:${billingCancellationIdentityKey(resource)}:${control.endpoint}`;
  const authorityStillMatches =
    !cancellationDialogOpen ||
    openedCancellationSignatureRef.current === cancellationAuthoritySignature;
  const canRenderCancellationDialog =
    control.eligible && canOfferCancellation && authorityStillMatches;
  const isPending =
    cancellationState?.kind === "submitting" ||
    cancellationState?.kind === "accepted";

  useEffect(() => {
    if (cancellationDialogWasOpenRef.current && !canRenderCancellationDialog) {
      submittedFromDialogRef.current = false;
      pendingDialogFocusRef.current = true;
      setCancellationDialogOpen(false);
    }
    cancellationDialogWasOpenRef.current =
      cancellationDialogOpen && canRenderCancellationDialog;
  }, [canRenderCancellationDialog, cancellationDialogOpen]);

  const receiptId =
    cancellationState && "receiptId" in cancellationState
      ? cancellationState.receiptId
      : undefined;
  const cancellationMessage = (() => {
    switch (cancellationState?.kind) {
      case "submitting":
        return t("cloud.billing.compute.cancel.submittingDetail", {
          defaultValue:
            "Submitting the durable request. Billing is still active.",
        });
      case "accepted":
        return isAgent
          ? t("cloud.billing.compute.cancel.acceptedAgentDetail", {
              defaultValue:
                "Request accepted. Compute charges continue until provider confirmation; any retained backup remains billable until it is deleted.",
            })
          : t("cloud.billing.compute.cancel.acceptedDetail", {
              defaultValue:
                "Request accepted. Billing remains active until provider confirmation.",
            });
      case "provider_confirmed":
        if (
          cancellationState.retainedBackupBilling.status === "billable" &&
          cancellationState.retainedBackupBilling.ratePerHour !== null
        ) {
          return t("cloud.billing.compute.cancel.confirmedBackupDetail", {
            rate: formatExactUsd(
              cancellationState.retainedBackupBilling.ratePerHour.toFixed(6),
            ),
            defaultValue:
              "Provider confirmed compute stopped. The retained backup remains billable at {{rate}}/hour until it is deleted.",
          });
        }
        return t("cloud.billing.compute.cancel.confirmedDetail", {
          defaultValue:
            "Provider confirmed compute stopped. No retained backup billing remains for this resource.",
        });
      case "conflict":
        return t("cloud.billing.compute.cancel.conflictDetail", {
          defaultValue:
            "The resource changed before this request completed. Refresh and review its current state.",
        });
      case "terminal_attention":
        return t("cloud.billing.compute.cancel.attentionDetail", {
          defaultValue:
            "The compute stop needs operator attention. Provider absence is not confirmed, so billing continues.",
        });
      case "ambiguous":
        return t("cloud.billing.compute.cancel.ambiguousDetail", {
          defaultValue:
            "The response was lost or unavailable. Retry safely with the same request identity.",
        });
      case "receipt_unavailable":
        return isAgent
          ? t("cloud.billing.compute.cancel.receiptUnavailableAgentDetail", {
              defaultValue:
                "The request was accepted, but its latest receipt could not be read. Compute charges and any retained-backup billing continue until confirmed otherwise.",
            })
          : t("cloud.billing.compute.cancel.receiptUnavailableDetail", {
              defaultValue:
                "The request was accepted, but its latest receipt could not be read. Billing remains active until provider confirmation.",
            });
      case "rejected":
        return t("cloud.billing.compute.cancel.rejectedDetail", {
          defaultValue:
            "The request was rejected. Refresh the billing snapshot before trying again.",
        });
      default:
        return null;
    }
  })();
  const cancellationIsAlert =
    cancellationState?.kind === "conflict" ||
    cancellationState?.kind === "terminal_attention" ||
    cancellationState?.kind === "ambiguous" ||
    cancellationState?.kind === "receipt_unavailable" ||
    cancellationState?.kind === "rejected";
  const cancellationBlockerMessage = control.blockers.includes(
    "billing_account_ineligible",
  )
    ? t("cloud.billing.compute.cancel.accountIneligible", {
        defaultValue:
          "This account or organization is not eligible to manage billing for this resource.",
      })
    : control.blockers.includes("interactive_session_required")
      ? t("cloud.billing.compute.cancel.interactiveRequired", {
          defaultValue:
            "Sign in with an interactive account session to manage billing for this resource.",
        })
      : t("cloud.billing.compute.cancel.managerRequired", {
          defaultValue:
            "Only organization owners and admins can manage billing for this resource.",
        });

  useEffect(() => {
    if (cancellationDialogOpen || !pendingDialogFocusRef.current) return;
    pendingDialogFocusRef.current = false;
    if (cancellationMessage) {
      cancellationStatusRef.current?.focus();
    } else if (!control.eligible) {
      cancellationBlockerRef.current?.focus();
    } else {
      cancellationTriggerRef.current?.focus();
    }
  }, [cancellationDialogOpen, cancellationMessage, control.eligible]);

  return (
    <Card asChild variant="brandSurface" padding="comfortable">
      <li className="min-w-0">
        <div className="flex min-w-0 items-start gap-3">
          <Badge
            variant="providerMark"
            size="providerMark"
            className="mt-0.5 shrink-0"
          >
            <ResourceIcon className="size-4" aria-hidden="true" />
          </Badge>
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

        <Card asChild variant="billingTopDivider">
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-strong">
                {t("cloud.billing.compute.rate", { defaultValue: "Rate" })}
              </dt>
              <dd className="mt-1 break-words text-sm text-txt-strong [overflow-wrap:anywhere]">
                {exactAmount(
                  resource.ratePerHour,
                  t("cloud.billing.compute.perHour", {
                    defaultValue: "/ hour",
                  }),
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
        </Card>

        <Card asChild variant="billingTopDivider">
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-strong">
                {t("cloud.billing.compute.billingPeriod", {
                  defaultValue: "Billing period",
                })}
              </dt>
              <dd className="mt-1 break-words font-mono text-sm text-txt-strong [overflow-wrap:anywhere]">
                {billingIntervalLabel(resource.billingInterval, t)}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-strong">
                {t("cloud.billing.compute.lastBilled", {
                  defaultValue: "Last billed",
                })}
              </dt>
              <dd className="mt-1 break-words font-mono text-sm text-txt-strong [overflow-wrap:anywhere]">
                {billingCursorLabel(
                  resource.lastBilledAt,
                  t("cloud.billing.compute.notReported", {
                    defaultValue: "Not reported",
                  }),
                )}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-strong">
                {t("cloud.billing.compute.nextBilling", {
                  defaultValue: "Next billing",
                })}
              </dt>
              <dd className="mt-1 break-words font-mono text-sm text-txt-strong [overflow-wrap:anywhere]">
                {billingCursorLabel(
                  resource.nextBillingAt,
                  t("cloud.billing.compute.notScheduled", {
                    defaultValue: "Not scheduled",
                  }),
                )}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-strong">
                {t("cloud.billing.compute.estimatedNextBilling", {
                  defaultValue: "Estimated next billing",
                })}
              </dt>
              <dd className="mt-1 break-words font-mono text-sm text-txt-strong [overflow-wrap:anywhere]">
                {billingCursorLabel(
                  resource.estimatedNextBillingAt,
                  t("cloud.billing.compute.notEstimated", {
                    defaultValue: "Not estimated",
                  }),
                )}
              </dd>
            </div>
          </dl>
        </Card>

        {onRequestCancellation ? (
          <Card asChild variant="billingTopDivider">
            <div className="mt-4 space-y-3">
              {!control.eligible ? (
                <Alert
                  ref={cancellationBlockerRef}
                  tabIndex={-1}
                  role="status"
                  variant="default"
                >
                  {cancellationBlockerMessage}
                </Alert>
              ) : null}

              {cancellationMessage ? (
                <Alert
                  ref={cancellationStatusRef}
                  tabIndex={-1}
                  role={cancellationIsAlert ? "alert" : "status"}
                  aria-live={cancellationIsAlert ? "assertive" : "polite"}
                  variant={
                    cancellationState?.kind === "provider_confirmed"
                      ? "dashboardSuccess"
                      : cancellationIsAlert
                        ? "warningStrong"
                        : "default"
                  }
                >
                  <div className="flex items-start gap-2">
                    {isPending ? (
                      <Loader2
                        className="mt-0.5 h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : cancellationState?.kind === "provider_confirmed" ? (
                      <CheckCircle2
                        className="mt-0.5 h-4 w-4 shrink-0"
                        aria-hidden="true"
                      />
                    ) : (
                      <AlertCircle
                        className="mt-0.5 h-4 w-4 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <div className="min-w-0">
                      <p>{cancellationMessage}</p>
                      {receiptId ? (
                        <p className="mt-2 break-all font-mono text-xs">
                          {t("cloud.billing.compute.cancel.receipt", {
                            receiptId,
                            defaultValue: "Receipt: {{receiptId}}",
                          })}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </Alert>
              ) : null}

              {control.eligible &&
              cancellationState?.kind === "receipt_unavailable" ? (
                <Button
                  type="button"
                  variant="outline"
                  className="keyboard-focus-surface min-h-11 min-w-11 font-mono"
                  onClick={() => onCheckCancellationReceipt?.(resource)}
                  disabled={!onCheckCancellationReceipt}
                >
                  <RefreshCw aria-hidden="true" />
                  {t("cloud.billing.compute.cancel.checkStatus", {
                    defaultValue: "Check status",
                  })}
                </Button>
              ) : null}

              {canRenderCancellationDialog ? (
                <AlertDialog
                  open={cancellationDialogOpen}
                  onOpenChange={(open) => {
                    if (open) {
                      openedCancellationSignatureRef.current =
                        cancellationAuthoritySignature;
                      cancellationDialogWasOpenRef.current = true;
                    }
                    setCancellationDialogOpen(open);
                  }}
                >
                  <AlertDialogTrigger asChild>
                    <Button
                      ref={cancellationTriggerRef}
                      type="button"
                      variant="dangerOutline"
                      className="keyboard-focus-surface min-h-11 min-w-11 font-mono"
                      disabled={!canSubmit}
                    >
                      {isRetry
                        ? t("cloud.billing.compute.cancel.retryRequest", {
                            defaultValue: "Retry request",
                          })
                        : actionLabel}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent
                    onCloseAutoFocus={(event) => {
                      if (!submittedFromDialogRef.current) return;
                      submittedFromDialogRef.current = false;
                      event.preventDefault();
                      cancellationStatusRef.current?.focus();
                    }}
                  >
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {isAgent
                          ? t(
                              "cloud.billing.compute.cancel.confirmSuspendTitle",
                              {
                                defaultValue: "Stop compute for this agent?",
                              },
                            )
                          : t("cloud.billing.compute.cancel.confirmStopTitle", {
                              defaultValue: "Stop this container?",
                            })}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {isAgent
                          ? t(
                              "cloud.billing.compute.cancel.confirmAgentDetail",
                              {
                                resourceName: resource.name,
                                defaultValue:
                                  "This sends a durable compute-stop request for {{resourceName}}. Compute charges continue until provider confirmation, and its retained backup remains billable until deleted.",
                              },
                            )
                          : t("cloud.billing.compute.cancel.confirmDetail", {
                              resourceName: resource.name,
                              defaultValue:
                                "This sends a durable stop request for {{resourceName}}. Billing continues until the provider confirms the stop.",
                            })}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="keyboard-focus-surface min-h-11">
                        {t("cloud.billing.compute.cancel.keepRunning", {
                          defaultValue: "Keep running",
                        })}
                      </AlertDialogCancel>
                      <AlertDialogAction asChild>
                        <Button
                          type="button"
                          variant="destructive"
                          className="keyboard-focus-surface min-h-11"
                          onClick={() => {
                            submittedFromDialogRef.current = true;
                            onRequestCancellation(resource);
                          }}
                        >
                          {isRetry
                            ? t("cloud.billing.compute.cancel.confirmRetry", {
                                defaultValue: "Retry safely",
                              })
                            : actionLabel}
                        </Button>
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </div>
          </Card>
        ) : null}
      </li>
    </Card>
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
      size="touch"
      onClick={onRetry}
      disabled={retrying}
    >
      <RefreshCw
        className={`size-4 motion-reduce:animate-none ${retrying ? "animate-spin" : ""}`}
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
    <Card
      variant="brand"
      role="status"
      aria-busy="true"
      aria-label={t("cloud.billing.compute.loading", {
        defaultValue: "Loading active compute",
      })}
    >
      <CornerBrackets size="sm" />
      <div className="relative z-10 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
          <Skeleton className="h-8 w-28" />
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </Card>
  );
}

/** Pure, storyable view for one billing-snapshot query state. */
export function ActiveComputeCardView({
  state,
  onRetry,
  cancellationAuthorityKey = "",
  cancellationStates = {},
  onRequestCancellation,
  onCheckCancellationReceipt,
}: ActiveComputeCardProps) {
  const t = useCloudT();

  if (state.kind === "loading") return <LoadingCard t={t} />;

  if (state.kind === "paused" || state.kind === "error") {
    const paused = state.kind === "paused";
    const retrying = state.kind === "error" && state.retrying;
    return (
      <Card variant="brand">
        <CornerBrackets size="sm" />
        <div className="relative z-10 flex flex-col items-start gap-4 sm:flex-row sm:justify-between">
          <div role="alert" className="flex min-w-0 items-start gap-3">
            <AlertCircle
              className="mt-0.5  size-5 shrink-0 text-warn"
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
      </Card>
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
    <Card variant="brand" aria-busy={state.refreshing || undefined}>
      <CornerBrackets size="sm" />
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
                className="size-4 shrink-0 text-muted-strong"
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
          <Card
            variant="warningNotice"
            padding="default"
            role="alert"
            className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 items-start gap-2 text-sm text-txt">
              <Clock3
                className="mt-0.5 size-4 shrink-0 text-warn"
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
          </Card>
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
            <Card variant="brandSurface" className="px-4 py-8 text-center">
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
            </Card>
          ) : (
            <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {resourcesObservation.value.map((resource) => (
                <ResourceCard
                  key={`${resource.resourceType}:${resource.resourceId}`}
                  resource={resource}
                  t={t}
                  cancellationAuthorityKey={cancellationAuthorityKey}
                  cancellationState={
                    cancellationStates[billingCancellationIdentityKey(resource)]
                  }
                  onRequestCancellation={onRequestCancellation}
                  onCheckCancellationReceipt={onCheckCancellationReceipt}
                />
              ))}
            </ul>
          )
        ) : (
          <Card
            variant="brandSurface"
            className="flex flex-col items-start gap-4 p-4 sm:flex-row sm:justify-between"
          >
            <div className="flex min-w-0 items-start gap-3">
              <AlertCircle
                className="mt-0.5 size-4 shrink-0 text-warn"
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
            {canRetryObservation(resourcesObservation) || retryablePartial ? (
              <RetryButton
                onRetry={onRetry}
                retrying={state.refreshing}
                t={t}
              />
            ) : null}
          </Card>
        )}

        {resourcesObservation.status === "available" && hasPartialCost ? (
          <Card
            variant="warningNotice"
            padding="default"
            className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 items-start gap-2 text-sm text-txt">
              <AlertCircle
                className="mt-0.5 size-4 shrink-0 text-warn"
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
          </Card>
        ) : null}
      </div>
    </Card>
  );
}
