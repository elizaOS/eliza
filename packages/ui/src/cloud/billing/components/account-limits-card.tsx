/**
 * Renders the server-observed account-limit snapshot inside Cloud Billing.
 * Values and availability come only from `/api/v1/billing/limits`; the card
 * never derives entitlements, remaining capacity, or reset times in the
 * browser. A pure view export keeps every visual state deterministic for
 * stories, component tests, and evidence capture.
 */

"use client";

import type {
  AccountLimitsSnapshot,
  CountedLimitItem,
  LimitItemState,
  SandboxCreateLimitItem,
  StorageLimitItem,
} from "@elizaos/cloud-shared/lib/services/account-limits-snapshot";
import { BrandCard } from "@elizaos/ui/cloud-ui";
import {
  AlertTriangle,
  Bot,
  Box,
  Boxes,
  Gauge,
  HardDrive,
  LayoutGrid,
  Loader2,
  RefreshCw,
  SlidersHorizontal,
  WifiOff,
} from "lucide-react";
import { type ComponentType, type ReactNode, useCallback, useRef } from "react";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import {
  StatusBadge,
  type StatusVariant,
} from "../../../components/ui/status-badge";
import { useCloudI18n, useCloudT } from "../../shell/CloudI18nProvider";
import { useAccountLimitsSnapshot } from "../data/account-limits";

type LimitIcon = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean;
}>;

export type AccountLimitsCardViewState =
  | { kind: "loading" }
  | { kind: "paused" }
  | { kind: "error"; retrying: boolean }
  | {
      kind: "ready";
      snapshot: AccountLimitsSnapshot;
      refreshing: boolean;
      refreshPaused?: boolean;
      refreshFailed: boolean;
    };

export interface AccountLimitsCardViewProps {
  state: AccountLimitsCardViewState;
  onRetry?: () => void;
}

type Translator = ReturnType<typeof useCloudT>;

const BYTE_UNITS = [
  { bytes: 1_125_899_906_842_624n, label: "PiB" },
  { bytes: 1_099_511_627_776n, label: "TiB" },
  { bytes: 1_073_741_824n, label: "GiB" },
  { bytes: 1_048_576n, label: "MiB" },
  { bytes: 1_024n, label: "KiB" },
] as const;

function formatInteger(value: number, lang: string): string {
  return new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }).format(
    value,
  );
}

function groupDecimalDigits(value: string, lang: string): string {
  return new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }).format(
    BigInt(value),
  );
}

function formatBytes(value: string, lang: string, byteUnit: string): string {
  const bytes = BigInt(value);
  if (bytes === 0n) return `0 ${byteUnit}`;
  const unit = BYTE_UNITS.find((candidate) => bytes >= candidate.bytes);
  if (!unit) return `${groupDecimalDigits(value, lang)} ${byteUnit}`;

  const hundredths = (bytes * 100n) / unit.bytes;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, "0");
  const trimmedFraction = fraction.replace(/0+$/, "");
  const decimalSeparator =
    new Intl.NumberFormat(lang)
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value ?? ".";
  return `${groupDecimalDigits(whole.toString(), lang)}${
    trimmedFraction.length > 0 ? `${decimalSeparator}${trimmedFraction}` : ""
  } ${unit.label}`;
}

function formatObservedAt(value: string, lang: string): string {
  return new Intl.DateTimeFormat(lang, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value));
}

function statePresentation(
  state: LimitItemState,
  t: Translator,
): {
  label: string;
  tone: StatusVariant;
} {
  if (state === "available") {
    return {
      label: t("cloud.billing.limits.state.available", {
        defaultValue: "Available",
      }),
      tone: "success",
    };
  }
  if (state === "at-limit") {
    return {
      label: t("cloud.billing.limits.state.atLimit", {
        defaultValue: "At limit",
      }),
      tone: "warning",
    };
  }
  if (state === "over-limit") {
    return {
      label: t("cloud.billing.limits.state.overLimit", {
        defaultValue: "Over limit",
      }),
      tone: "danger",
    };
  }
  return {
    label: t("cloud.billing.limits.state.unavailable", {
      defaultValue: "Unavailable",
    }),
    tone: "muted",
  };
}

function sourcePresentation(source: string, t: Translator): string {
  const labels: Record<string, { key: string; fallback: string }> = {
    "cloud-character-quota": {
      key: "cloud.billing.limits.source.cloudCharacters",
      fallback: "Cloud character policy",
    },
    "agent-sandbox-quota": {
      key: "cloud.billing.limits.source.agentSandboxes",
      fallback: "Agent sandbox policy",
    },
    "container-quota": {
      key: "cloud.billing.limits.source.containers",
      fallback: "Container policy",
    },
    "apps-service": {
      key: "cloud.billing.limits.source.apps",
      fallback: "Application policy",
    },
    "org-storage-quota": {
      key: "cloud.billing.limits.source.storage",
      fallback: "Upload storage quota",
    },
    "org-rate-limits": {
      key: "cloud.billing.limits.source.inference",
      fallback: "Inference admission policy",
    },
  };
  const known = labels[source];
  return known ? t(known.key, { defaultValue: known.fallback }) : source;
}

function LimitStateBadge({ state }: { state: LimitItemState }) {
  const t = useCloudT();
  const presentation = statePresentation(state, t);
  return (
    <StatusBadge
      label={presentation.label}
      status={presentation.tone}
      withDot
      className="shrink-0 text-txt-strong"
    />
  );
}

interface LimitMetricProps {
  label: string;
  icon: LimitIcon;
  state: LimitItemState;
  source: string;
  value?: ReactNode;
  detail?: ReactNode;
  wide?: boolean;
}

function SourceLine({ source }: { source: string }) {
  const t = useCloudT();
  const presentedSource = sourcePresentation(source, t);
  const sourceLabel = t("cloud.billing.limits.source.label", {
    defaultValue: "Source",
  });
  return (
    <p className="mt-auto break-words text-xs leading-relaxed text-muted">
      {sourceLabel}: {presentedSource}
      {presentedSource === source ? null : (
        <span className="font-mono [overflow-wrap:anywhere]"> ({source})</span>
      )}
    </p>
  );
}

function LimitMetric({
  label,
  icon: Icon,
  state,
  source,
  value,
  detail,
  wide = false,
}: LimitMetricProps) {
  const t = useCloudT();
  return (
    <article
      className={`flex min-w-0 flex-col gap-3 rounded-sm border border-border bg-surface p-4${wide ? " sm:col-span-2" : ""}`}
      data-limit-state={state}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <h4 className="flex min-w-0 items-center gap-2 text-sm font-medium text-txt-strong">
          <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0">{label}</span>
        </h4>
        <LimitStateBadge state={state} />
      </div>
      <div className="min-w-0">
        {state === "unavailable" ? (
          <p className="text-sm font-medium text-txt-strong">
            {t("cloud.billing.limits.unavailableValue", {
              defaultValue: "Limit unavailable",
            })}
          </p>
        ) : (
          <p className="break-words font-mono text-base tabular-nums text-txt-strong">
            {value}
          </p>
        )}
        {detail ? (
          <div className="mt-1 break-words text-xs leading-relaxed text-muted">
            {detail}
          </div>
        ) : null}
      </div>
      <SourceLine source={source} />
    </article>
  );
}

function countedMetric(
  item: CountedLimitItem,
  label: string,
  icon: LimitIcon,
  t: Translator,
  lang: string,
  readyDetail?: ReactNode,
): ReactNode {
  return (
    <LimitMetric
      label={label}
      icon={icon}
      state={item.state}
      source={item.source}
      value={
        item.used === undefined || item.limit === undefined
          ? undefined
          : t("cloud.billing.limits.countedValue", {
              defaultValue: "{{used}} of {{limit}} used",
              used: formatInteger(item.used, lang),
              limit: formatInteger(item.limit, lang),
            })
      }
      detail={
        item.state === "unavailable"
          ? t("cloud.billing.limits.unavailableDetail", {
              defaultValue:
                "The server could not read this limit. No fallback value is shown.",
            })
          : readyDetail
      }
    />
  );
}

function SandboxMetric({
  item,
}: {
  item: AccountLimitsSnapshot["agentSandboxes"];
}) {
  const { t, lang } = useCloudI18n();
  const paths: Array<{
    key: "standard" | "managed";
    label: string;
    value: SandboxCreateLimitItem;
  }> = [
    {
      key: "standard",
      label: t("cloud.billing.limits.sandbox.standardPath", {
        defaultValue: "Standard sandbox create path",
      }),
      value: item.nonEagerCreate,
    },
    {
      key: "managed",
      label: t("cloud.billing.limits.sandbox.managedPath", {
        defaultValue: "Managed sandbox create path",
      }),
      value: item.eagerManagedCreate,
    },
  ];
  const formattedUsage =
    item.used === undefined ? null : formatInteger(item.used, lang);

  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-sm border border-border bg-surface p-4 sm:col-span-2">
      <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-txt-strong">
        <Box className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <h4>
          {t("cloud.billing.limits.sandbox.label", {
            defaultValue: "Agent sandboxes",
          })}
        </h4>
      </div>
      <p className="text-sm leading-relaxed text-muted">
        {formattedUsage === null
          ? t("cloud.billing.limits.sandbox.sharedUsageUnavailable", {
              defaultValue: "Shared counted usage is unavailable.",
            })
          : t("cloud.billing.limits.sandbox.sharedUsage", {
              defaultValue:
                "Both create paths use the same current count of {{used}} sandboxes. Stopped and sleeping sandboxes are included in that shared count.",
              used: formattedUsage,
            })}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {paths.map((path) => (
          <section
            key={path.key}
            aria-label={path.label}
            className="min-w-0 space-y-2 rounded-sm border border-border bg-card p-3"
          >
            <div className="flex min-w-0 items-start justify-between gap-3">
              <h5 className="text-sm font-medium text-txt-strong">
                {path.label}
              </h5>
              <LimitStateBadge state={path.value.state} />
            </div>
            <p className="break-words font-mono text-sm tabular-nums text-txt-strong">
              {path.value.state === "unavailable" ||
              path.value.limit === undefined
                ? t("cloud.billing.limits.unavailableValue", {
                    defaultValue: "Limit unavailable",
                  })
                : t("cloud.billing.limits.sandbox.createCap", {
                    defaultValue: "Create cap: {{limit}}",
                    limit: formatInteger(path.value.limit, lang),
                  })}
            </p>
          </section>
        ))}
      </div>
      <SourceLine source={item.source} />
    </article>
  );
}

function StorageMetric({ item }: { item: StorageLimitItem }) {
  const { t, lang } = useCloudI18n();
  if (
    item.state === "unavailable" ||
    item.bytesUsed === undefined ||
    item.bytesLimit === undefined
  ) {
    return (
      <LimitMetric
        label={t("cloud.billing.limits.storage.label", {
          defaultValue: "Quota-accounted uploads",
        })}
        icon={HardDrive}
        state="unavailable"
        source={item.source}
        detail={t("cloud.billing.limits.storage.unavailableDetail", {
          defaultValue:
            "The server could not read quota-accounted upload storage.",
        })}
      />
    );
  }

  const { bytesUsed, bytesLimit } = item;
  const byteUnit = t("cloud.billing.limits.storage.bytes", {
    defaultValue: "bytes",
  });
  return (
    <LimitMetric
      label={t("cloud.billing.limits.storage.label", {
        defaultValue: "Quota-accounted uploads",
      })}
      icon={HardDrive}
      state={item.state}
      source={item.source}
      value={t("cloud.billing.limits.storage.value", {
        defaultValue: "{{used}} of {{limit}} used",
        used: formatBytes(bytesUsed, lang, byteUnit),
        limit: formatBytes(bytesLimit, lang, byteUnit),
      })}
      detail={
        <>
          <span className="block font-mono tabular-nums">
            {t("cloud.billing.limits.storage.exact", {
              defaultValue: "Exact: {{used}} / {{limit}} bytes",
              used: groupDecimalDigits(bytesUsed, lang),
              limit: groupDecimalDigits(bytesLimit, lang),
            })}
          </span>
          <span className="mt-1 block">
            {t("cloud.billing.limits.storage.detail", {
              defaultValue:
                "This covers uploads tracked by the storage quota, not every stored object.",
            })}
          </span>
        </>
      }
    />
  );
}

function InferenceMetric({
  item,
}: {
  item: AccountLimitsSnapshot["inferenceRateLimits"];
}) {
  const { t, lang } = useCloudI18n();
  if (
    item.state !== "available" ||
    item.completionsRpm === undefined ||
    item.embeddingsRpm === undefined
  ) {
    return (
      <LimitMetric
        label={t("cloud.billing.limits.inference.label", {
          defaultValue: "Inference rate caps",
        })}
        icon={Gauge}
        state="unavailable"
        source={item.source}
        detail={t("cloud.billing.limits.inference.unavailableDetail", {
          defaultValue: "The configured inference caps could not be loaded.",
        })}
      />
    );
  }

  return (
    <LimitMetric
      label={t("cloud.billing.limits.inference.label", {
        defaultValue: "Inference rate caps",
      })}
      icon={Gauge}
      state={item.state}
      source={item.source}
      value={
        <span className="flex flex-col gap-1">
          <span>
            {t("cloud.billing.limits.inference.completions", {
              defaultValue: "{{limit}} completions / min",
              limit: formatInteger(item.completionsRpm, lang),
            })}
          </span>
          <span>
            {t("cloud.billing.limits.inference.embeddings", {
              defaultValue: "{{limit}} embeddings / min",
              limit: formatInteger(item.embeddingsRpm, lang),
            })}
          </span>
        </span>
      }
      detail={t("cloud.billing.limits.inference.detail", {
        defaultValue:
          "Configured caps only. Current usage, remaining requests, enforcement status, and reset time are not reported here.",
      })}
      wide
    />
  );
}

function RetryButton({
  busy,
  paused = false,
  onRetry,
  label,
}: {
  busy: boolean;
  paused?: boolean;
  onRetry: () => void;
  label: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onRetry}
      disabled={busy || paused}
      aria-busy={busy}
      className="keyboard-focus-surface min-h-11 shrink-0 gap-2"
    >
      {paused ? (
        <WifiOff className="h-4 w-4" aria-hidden />
      ) : busy ? (
        <Loader2
          className="h-4 w-4 animate-spin motion-reduce:animate-none"
          aria-hidden
        />
      ) : (
        <RefreshCw className="h-4 w-4" aria-hidden />
      )}
      {label}
    </Button>
  );
}

function LimitsHeader({
  refreshing,
  refreshPaused,
  onRetry,
}: {
  refreshing?: boolean;
  refreshPaused?: boolean;
  onRetry?: () => void;
}) {
  const t = useCloudT();
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <SlidersHorizontal
            className="h-4 w-4 shrink-0 text-muted"
            aria-hidden
          />
          <h3
            id="account-limits-title"
            className="text-base font-mono uppercase text-txt"
          >
            {t("cloud.billing.limits.title", {
              defaultValue: "Account limits",
            })}
          </h3>
          {refreshing || refreshPaused ? (
            <span role="status" aria-live="polite">
              <StatusBadge
                label={
                  refreshPaused
                    ? t("cloud.billing.limits.waitingConnection", {
                        defaultValue: "Waiting for connection",
                      })
                    : t("cloud.billing.limits.refreshing", {
                        defaultValue: "Refreshing",
                      })
                }
                status={refreshPaused ? "warning" : "processing"}
                className="shrink-0 text-txt-strong motion-reduce:[&>svg]:animate-none"
              />
            </span>
          ) : null}
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          {t("cloud.billing.limits.description", {
            defaultValue:
              "Current caps observed by the Cloud backend. Unavailable sources stay explicit instead of becoming zero or unlimited.",
          })}
        </p>
      </div>
      {onRetry ? (
        <RetryButton
          busy={Boolean(refreshing)}
          paused={Boolean(refreshPaused)}
          onRetry={onRetry}
          label={
            refreshPaused
              ? t("cloud.billing.limits.waitingConnection", {
                  defaultValue: "Waiting for connection",
                })
              : t("cloud.billing.limits.refresh", {
                  defaultValue: "Refresh limits",
                })
          }
        />
      ) : null}
    </div>
  );
}

function LoadingState() {
  const t = useCloudT();
  const slots = [
    "cloud-characters",
    "standard-sandboxes",
    "managed-sandboxes",
    "containers",
    "applications",
    "storage",
    "inference",
  ] as const;
  return (
    <BrandCard data-testid="account-limits-card">
      <section
        aria-label={t("cloud.billing.limits.loading", {
          defaultValue: "Loading account limits",
        })}
        aria-busy="true"
        role="status"
        className="space-y-6"
      >
        <LimitsHeader />
        <span className="sr-only">
          {t("cloud.billing.limits.loading", {
            defaultValue: "Loading account limits",
          })}
        </span>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-hidden>
          {slots.map((slot) => (
            <div
              key={slot}
              className="space-y-4 rounded-sm border border-border bg-surface p-4"
            >
              <div className="flex items-center justify-between gap-4">
                <Skeleton className="h-4 w-32 motion-reduce:animate-none" />
                <Skeleton className="h-5 w-20 motion-reduce:animate-none" />
              </div>
              <Skeleton className="h-6 w-40 motion-reduce:animate-none" />
              <Skeleton className="h-3 w-28 motion-reduce:animate-none" />
            </div>
          ))}
        </div>
      </section>
    </BrandCard>
  );
}

function ErrorState({
  retrying,
  onRetry,
}: {
  retrying: boolean;
  onRetry: () => void;
}) {
  const t = useCloudT();
  return (
    <BrandCard data-testid="account-limits-card">
      <section aria-labelledby="account-limits-title" className="space-y-6">
        <LimitsHeader />
        <div
          role="alert"
          className="flex flex-col gap-4 rounded-sm border border-warn/40 bg-warn/10 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-start gap-3">
            <AlertTriangle
              className="mt-0.5 h-5 w-5 shrink-0 text-warn"
              aria-hidden
            />
            <div className="min-w-0">
              <p className="font-medium text-txt-strong">
                {t("cloud.billing.limits.error.title", {
                  defaultValue: "Account limits unavailable",
                })}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                {t("cloud.billing.limits.error.detail", {
                  defaultValue:
                    "The current snapshot could not be loaded. No fallback limits are shown.",
                })}
              </p>
            </div>
          </div>
          <RetryButton
            busy={retrying}
            onRetry={onRetry}
            label={t("cloud.billing.limits.retry", {
              defaultValue: "Retry loading limits",
            })}
          />
        </div>
      </section>
    </BrandCard>
  );
}

function PausedState() {
  const t = useCloudT();
  return (
    <BrandCard data-testid="account-limits-card">
      <section aria-labelledby="account-limits-title" className="space-y-6">
        <LimitsHeader />
        <div
          role="status"
          aria-live="polite"
          className="flex flex-col gap-4 rounded-sm border border-border bg-bg-accent p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-start gap-3">
            <WifiOff
              className="mt-0.5 h-5 w-5 shrink-0 text-muted"
              aria-hidden
            />
            <div className="min-w-0">
              <p className="font-medium text-txt-strong">
                {t("cloud.billing.limits.paused.title", {
                  defaultValue: "Waiting for a connection",
                })}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                {t("cloud.billing.limits.paused.detail", {
                  defaultValue:
                    "Account limits have not loaded. The request will resume when a connection is available.",
                })}
              </p>
            </div>
          </div>
          <RetryButton
            busy={false}
            paused
            onRetry={() => undefined}
            label={t("cloud.billing.limits.waitingConnection", {
              defaultValue: "Waiting for connection",
            })}
          />
        </div>
      </section>
    </BrandCard>
  );
}

function snapshotHasUnavailable(snapshot: AccountLimitsSnapshot): boolean {
  return (
    snapshot.cloudCharacters.state === "unavailable" ||
    snapshot.agentSandboxes.nonEagerCreate.state === "unavailable" ||
    snapshot.agentSandboxes.eagerManagedCreate.state === "unavailable" ||
    snapshot.containers.state === "unavailable" ||
    snapshot.apps.state === "unavailable" ||
    snapshot.storage.state === "unavailable" ||
    snapshot.inferenceRateLimits.state === "unavailable"
  );
}

function ReadyState({
  snapshot,
  refreshing,
  refreshPaused,
  refreshFailed,
  onRetry,
}: {
  snapshot: AccountLimitsSnapshot;
  refreshing: boolean;
  refreshPaused: boolean;
  refreshFailed: boolean;
  onRetry: () => void;
}) {
  const { t, lang } = useCloudI18n();
  const hasUnavailable = snapshotHasUnavailable(snapshot);
  return (
    <BrandCard data-testid="account-limits-card">
      <section
        aria-labelledby="account-limits-title"
        aria-busy={refreshing}
        className="space-y-6"
      >
        <LimitsHeader
          refreshing={refreshing}
          refreshPaused={refreshPaused}
          onRetry={onRetry}
        />

        {refreshFailed ? (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-sm border border-warn/40 bg-warn/10 p-4"
          >
            <AlertTriangle
              className="mt-0.5 h-5 w-5 shrink-0 text-warn"
              aria-hidden
            />
            <div className="min-w-0 text-sm leading-relaxed">
              <p className="font-medium text-txt-strong">
                {t("cloud.billing.limits.stale.title", {
                  defaultValue: "Could not refresh account limits",
                })}
              </p>
              <p className="mt-1 text-muted">
                {t("cloud.billing.limits.stale.prefix", {
                  defaultValue: "Showing the last snapshot observed at",
                })}{" "}
                <time dateTime={snapshot.observedAt}>
                  {formatObservedAt(snapshot.observedAt, lang)}
                </time>
                .
              </p>
            </div>
          </div>
        ) : refreshPaused ? (
          <div
            role="status"
            aria-live="polite"
            className="flex items-start gap-3 rounded-sm border border-border bg-bg-accent p-4"
          >
            <WifiOff
              className="mt-0.5 h-5 w-5 shrink-0 text-muted"
              aria-hidden
            />
            <p className="text-sm leading-relaxed text-muted">
              {t("cloud.billing.limits.pausedRefresh.prefix", {
                defaultValue:
                  "Refresh paused until a connection is available. Showing the snapshot observed at",
              })}{" "}
              <time dateTime={snapshot.observedAt}>
                {formatObservedAt(snapshot.observedAt, lang)}
              </time>
              .
            </p>
          </div>
        ) : hasUnavailable ? (
          <div
            role="status"
            aria-live="polite"
            className="flex items-start gap-3 rounded-sm border border-border bg-bg-accent p-4"
          >
            <AlertTriangle
              className="mt-0.5 h-5 w-5 shrink-0 text-muted"
              aria-hidden
            />
            <p className="text-sm leading-relaxed text-muted">
              {t("cloud.billing.limits.partial", {
                defaultValue:
                  "Some limit sources are unavailable. Available resources remain visible, and no fallback values are substituted.",
              })}
            </p>
          </div>
        ) : null}

        <section
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          aria-label={t("cloud.billing.limits.gridLabel", {
            defaultValue: "Observed account limits",
          })}
        >
          {countedMetric(
            snapshot.cloudCharacters,
            t("cloud.billing.limits.cloudCharacters", {
              defaultValue: "App-agent cloud characters",
            }),
            Bot,
            t,
            lang,
            t("cloud.billing.limits.cloudCharactersDetail", {
              defaultValue:
                "Count and cap reported for the app-agent creation path; other character paths may differ.",
            }),
          )}
          {countedMetric(
            snapshot.containers,
            t("cloud.billing.limits.containers", {
              defaultValue: "Containers",
            }),
            Boxes,
            t,
            lang,
          )}
          <SandboxMetric item={snapshot.agentSandboxes} />
          {countedMetric(
            snapshot.apps,
            t("cloud.billing.limits.apps", {
              defaultValue: "Applications",
            }),
            LayoutGrid,
            t,
            lang,
          )}
          <StorageMetric item={snapshot.storage} />
          <InferenceMetric item={snapshot.inferenceRateLimits} />
        </section>

        <p className="border-t border-border pt-4 text-xs leading-relaxed text-muted">
          {t("cloud.billing.limits.snapshot.prefix", {
            defaultValue: "Snapshot observed at",
          })}{" "}
          <time dateTime={snapshot.observedAt}>
            {formatObservedAt(snapshot.observedAt, lang)}
          </time>
          .{" "}
          {t("cloud.billing.limits.snapshot.detail", {
            defaultValue:
              "Remaining capacity and reset timing are not reported by this endpoint.",
          })}
        </p>
      </section>
    </BrandCard>
  );
}

/** Pure state renderer used by tests, stories, and evidence fixtures. */
export function AccountLimitsCardView({
  state,
  onRetry = () => undefined,
}: AccountLimitsCardViewProps) {
  if (state.kind === "loading") return <LoadingState />;
  if (state.kind === "paused") return <PausedState />;
  if (state.kind === "error") {
    return <ErrorState retrying={state.retrying} onRetry={onRetry} />;
  }
  return (
    <ReadyState
      snapshot={state.snapshot}
      refreshing={state.refreshing}
      refreshPaused={Boolean(state.refreshPaused)}
      refreshFailed={state.refreshFailed}
      onRetry={onRetry}
    />
  );
}

/** Auth-gated Account Limits card mounted by the canonical Billing surface. */
export function AccountLimitsCard({
  organizationId,
}: {
  organizationId: string;
}) {
  const query = useAccountLimitsSnapshot(organizationId);
  const retryInFlightRef = useRef(false);
  const { refetch } = query;

  const retry = useCallback(() => {
    if (retryInFlightRef.current) return;
    retryInFlightRef.current = true;
    const release = () => {
      retryInFlightRef.current = false;
    };
    void refetch().then(release, release);
  }, [refetch]);

  if (!query.data) {
    if (query.isPaused) {
      return <AccountLimitsCardView state={{ kind: "paused" }} />;
    }
    if (query.isPending && !query.isFetched) {
      return <AccountLimitsCardView state={{ kind: "loading" }} />;
    }
    return (
      <AccountLimitsCardView
        state={{ kind: "error", retrying: query.isFetching }}
        onRetry={retry}
      />
    );
  }

  return (
    <AccountLimitsCardView
      state={{
        kind: "ready",
        snapshot: query.data,
        refreshing: query.isFetching,
        refreshPaused: query.isPaused,
        refreshFailed:
          query.isRefetchError && !query.isFetching && !query.isPaused,
      }}
      onRetry={retry}
    />
  );
}
