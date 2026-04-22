import { Badge, Button, Textarea, useApp } from "@elizaos/app-core";
import type { LifeOpsCapabilityState } from "@elizaos/shared/contracts/lifeops";
import {
  Activity,
  Clock3,
  FileText,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
  Unplug,
  Wand2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { useLifeOpsCapabilitiesStatus } from "../hooks/useLifeOpsCapabilitiesStatus.js";
import { useLifeOpsScheduleState } from "../hooks/useLifeOpsScheduleState.js";
import { useLifeOpsStretchReminder } from "../hooks/useLifeOpsStretchReminder.js";
import { useLifeOpsXConnector } from "../hooks/useLifeOpsXConnector.js";

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "—";
  }
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatMinutes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "—";
  }
  return `${value} min`;
}

function readXIdentity(
  identity: Record<string, unknown> | null,
  fallback: string,
): string {
  if (!identity) {
    return fallback;
  }
  const keys = ["name", "username", "screen_name", "handle"] as const;
  for (const key of keys) {
    const value = identity[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  const identifier = identity.id;
  return typeof identifier === "string" && identifier.trim().length > 0
    ? identifier.trim()
    : fallback;
}

function capabilityStateLabel(state: LifeOpsCapabilityState): string {
  switch (state) {
    case "working":
      return "Working";
    case "degraded":
      return "Degraded";
    case "blocked":
      return "Blocked";
    case "not_configured":
      return "Not configured";
  }
}

function PanelShell({
  title,
  icon,
  status,
  children,
}: {
  title: string;
  icon: ReactNode;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-3xl border border-border/16 bg-card/18 px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {icon}
          <div className="truncate text-sm font-semibold text-txt">{title}</div>
        </div>
        {status}
      </div>
      {children}
    </section>
  );
}

export function LifeOpsCapabilitiesPanel() {
  const { t } = useApp();
  const capabilities = useLifeOpsCapabilitiesStatus();
  const status = capabilities.status;
  const primary =
    status?.capabilities.find((item) => item.id === "sleep.relative_time") ??
    status?.capabilities[0] ??
    null;

  return (
    <PanelShell
      title={t("lifeopspanels.capabilities", {
        defaultValue: "Capabilities",
      })}
      icon={<Activity className="h-4 w-4 shrink-0 text-muted" />}
      status={
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          onClick={() => void capabilities.refresh()}
          disabled={capabilities.loading}
        >
          {capabilities.loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("lifeopspanels.capabilityHealth", {
              defaultValue: "Health",
            })}
          </div>
          <div className="mt-1 text-sm font-semibold text-txt">
            {status
              ? `${status.summary.workingCount}/${status.summary.totalCount} working`
              : t("common.loading", { defaultValue: "Loading" })}
          </div>
          {status ? (
            <div className="mt-1 text-xs text-muted">
              {status.summary.degradedCount} degraded ·{" "}
              {status.summary.blockedCount} blocked
            </div>
          ) : null}
        </div>
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("lifeopspanels.primaryCapability", {
              defaultValue: "Awake clock",
            })}
          </div>
          <div className="mt-1 text-sm font-semibold text-txt">
            {primary?.summary ?? "—"}
          </div>
          {status?.relativeTime ? (
            <div className="mt-1 text-xs text-muted">
              Computed {formatDateTime(status.relativeTime.computedAt)}
            </div>
          ) : null}
        </div>
      </div>

      {status ? (
        <div className="flex flex-wrap gap-2">
          {status.capabilities.map((capability) => (
            <Badge
              key={capability.id}
              variant={capability.state === "working" ? "secondary" : "outline"}
              className="text-2xs"
              title={capability.summary}
            >
              {capability.label}: {capabilityStateLabel(capability.state)}
            </Badge>
          ))}
        </div>
      ) : null}

      {capabilities.error ? (
        <div className="text-xs text-danger">{capabilities.error}</div>
      ) : null}
    </PanelShell>
  );
}

export function LifeOpsSchedulePanel() {
  const { t } = useApp();
  const schedule = useLifeOpsScheduleState({ scope: "effective" });
  const merged = schedule.state;
  const sleepLabel = merged
    ? merged.sleepStatus === "sleeping_now"
      ? t("lifeopspanels.sleepingNow", { defaultValue: "Sleeping now" })
      : merged.sleepStatus === "slept"
        ? t("lifeopspanels.slept", { defaultValue: "Slept" })
        : merged.sleepStatus === "likely_missed"
          ? t("lifeopspanels.likelyMissed", {
              defaultValue: "Likely missed",
            })
          : t("lifeopspanels.unknown", { defaultValue: "Unknown" })
    : t("common.loading", { defaultValue: "Loading" });
  const relativeWakeLabel =
    merged?.relativeTime.minutesAwake !== null &&
    merged?.relativeTime.minutesAwake !== undefined
      ? t("lifeopspanels.relativePhase", {
          defaultValue: "{{phase}} · woke {{duration}} ago",
          phase: merged.relativeTime.phase,
          duration: formatMinutes(merged.relativeTime.minutesAwake),
        })
      : merged
        ? t("lifeopspanels.relativePhaseCalibrating", {
            defaultValue: "{{phase}} · {{awakeState}}",
            phase: merged.relativeTime.phase,
            awakeState: merged.relativeTime.awakeState,
          })
        : "—";
  const bedtimeRelativeLabel =
    merged?.relativeTime.minutesUntilBedtimeTarget !== null &&
    merged?.relativeTime.minutesUntilBedtimeTarget !== undefined
      ? t("lifeopspanels.bedtimeFuture", {
          defaultValue: "in {{duration}}",
          duration: formatMinutes(
            merged.relativeTime.minutesUntilBedtimeTarget,
          ),
        })
      : merged?.relativeTime.minutesSinceBedtimeTarget !== null &&
          merged?.relativeTime.minutesSinceBedtimeTarget !== undefined
        ? t("lifeopspanels.bedtimePast", {
            defaultValue: "{{duration}} ago",
            duration: formatMinutes(
              merged.relativeTime.minutesSinceBedtimeTarget,
            ),
          })
        : t("lifeopspanels.bedtimeRelativeCalibrating", {
            defaultValue: "calibrating",
          });

  return (
    <PanelShell
      title={t("lifeopspanels.schedule", { defaultValue: "Sleep & schedule" })}
      icon={<Clock3 className="h-4 w-4 shrink-0 text-muted" />}
      status={
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          onClick={() => void schedule.refresh()}
          disabled={schedule.loading}
        >
          {schedule.loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("lifeopspanels.sleepStatus", {
              defaultValue: "Sleep status",
            })}
          </div>
          <div className="mt-1 text-sm font-semibold text-txt">
            {sleepLabel}
          </div>
          <div className="mt-1 text-xs text-muted">
            {merged
              ? `${merged.phase} · ${formatPercent(merged.sleepConfidence)} confidence`
              : t("lifeopspanels.scheduleUnavailable", {
                  defaultValue: "No schedule state available.",
                })}
          </div>
        </div>
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("lifeopspanels.awakeProbability", {
              defaultValue: "Awake probability",
            })}
          </div>
          <div className="mt-1 text-sm font-semibold text-txt">
            {merged
              ? `${formatPercent(merged.awakeProbability.pAwake)} awake · ${formatPercent(merged.awakeProbability.pAsleep)} asleep`
              : "—"}
          </div>
          <div className="mt-1 text-xs text-muted">
            {merged
              ? `${formatPercent(merged.awakeProbability.pUnknown)} unknown · ${merged.relativeTime.awakeState}`
              : t("lifeopspanels.scheduleUnavailable", {
                  defaultValue: "No schedule state available.",
                })}
          </div>
        </div>
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("lifeopspanels.relativeTime", {
              defaultValue: "Relative time",
            })}
          </div>
          <div className="mt-1 text-sm font-semibold text-txt">
            {relativeWakeLabel}
          </div>
          <div className="mt-1 text-xs text-muted">
            {merged?.relativeTime.bedtimeTargetAt
              ? t("lifeopspanels.bedtimeTarget", {
                  defaultValue: "Bedtime target {{time}} · {{duration}}",
                  time: formatDateTime(merged.relativeTime.bedtimeTargetAt),
                  duration: bedtimeRelativeLabel,
                })
              : t("lifeopspanels.bedtimeCalibrating", {
                  defaultValue: "Bedtime target calibrating",
                })}
          </div>
        </div>
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("lifeopspanels.sleepWindow", {
              defaultValue: "Sleep window",
            })}
          </div>
          <div className="mt-1 text-sm font-semibold text-txt">
            {merged?.currentSleepStartedAt
              ? `Started ${formatDateTime(merged.currentSleepStartedAt)}`
              : merged?.lastSleepStartedAt
                ? `Last started ${formatDateTime(merged.lastSleepStartedAt)}`
                : "—"}
          </div>
          {merged?.wakeAt || merged?.lastSleepDurationMinutes ? (
            <div className="mt-1 text-xs text-muted">
              {merged?.wakeAt
                ? `Wake target ${formatDateTime(merged.wakeAt)}`
                : null}
              {merged?.lastSleepDurationMinutes
                ? ` ${Math.round(merged.lastSleepDurationMinutes)} min last sleep`
                : null}
            </div>
          ) : null}
        </div>
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("lifeopspanels.regularity", {
              defaultValue: "Regularity",
            })}
          </div>
          <div className="mt-1 text-sm font-semibold text-txt">
            {merged
              ? `${merged.regularity.regularityClass.replace(/_/g, " ")} · SRI ${Math.round(merged.regularity.sri)}`
              : "—"}
          </div>
          <div className="mt-1 text-xs text-muted">
            {merged
              ? `${Math.round(merged.regularity.bedtimeStddevMin)}m bedtime stddev · ${Math.round(merged.regularity.wakeStddevMin)}m wake stddev`
              : t("lifeopspanels.scheduleUnavailable", {
                  defaultValue: "No schedule state available.",
                })}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {merged ? (
          <>
            <Badge variant="outline" className="text-2xs">
              {merged.scope}
            </Badge>
            <Badge variant="outline" className="text-2xs">
              {merged.contributingDeviceKinds.length} devices
            </Badge>
            <Badge variant="outline" className="text-2xs">
              {merged.observationCount} observations
            </Badge>
            <Badge variant="outline" className="text-2xs">
              computed {formatDateTime(merged.relativeTime.computedAt)}
            </Badge>
          </>
        ) : null}
        {schedule.error ? (
          <span className="text-xs text-danger">{schedule.error}</span>
        ) : null}
      </div>
    </PanelShell>
  );
}

export function LifeOpsXPanel() {
  const { t } = useApp();
  const ownerX = useLifeOpsXConnector("owner");
  const agentX = useLifeOpsXConnector("agent");
  const [draft, setDraft] = useState("");
  const status = ownerX.status;
  const agentStatus = agentX.status;
  const connected = status?.connected === true;
  const agentConnected = agentStatus?.connected === true;
  const hasAgentWrite =
    agentStatus?.grantedCapabilities.includes("x.write") === true;
  const identity = readXIdentity(
    status?.identity ?? null,
    t("lifeopspanels.notConnected", { defaultValue: "Not connected" }),
  );
  const mode = status?.mode ?? status?.defaultMode ?? "cloud_managed";
  const actionPending = ownerX.actionPending || agentX.actionPending;

  const handlePost = useCallback(() => {
    const text = draft.trim();
    if (!text) {
      return;
    }
    void agentX.post(text).then(() => setDraft(""));
  }, [agentX, draft]);

  return (
    <PanelShell
      title={t("lifeopspanels.xAccount", { defaultValue: "X account" })}
      icon={<Sparkles className="h-4 w-4 shrink-0 text-muted" />}
      status={
        <div className="flex items-center gap-2">
          <Badge
            variant={connected ? "secondary" : "outline"}
            className="text-2xs"
          >
            {connected
              ? t("lifeopspanels.connected", { defaultValue: "Connected" })
              : t("lifeopspanels.disconnected", {
                  defaultValue: "Disconnected",
                })}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            onClick={() => {
              void ownerX.refresh();
              void agentX.refresh();
            }}
            disabled={ownerX.loading || agentX.loading}
          >
            {ownerX.loading || agentX.loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("lifeopspanels.identity", { defaultValue: "Identity" })}
          </div>
          <div className="mt-1 text-sm font-semibold text-txt">{identity}</div>
          <div className="mt-1 text-xs text-muted">
            {status?.hasCredentials
              ? t("lifeopspanels.credentialsReady", {
                  defaultValue: "Credentials ready.",
                })
              : t("lifeopspanels.credentialsMissing", {
                  defaultValue:
                    "Connect through Eliza Cloud or configure local env.",
                })}
          </div>
        </div>
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("lifeopspanels.mode", { defaultValue: "Mode" })}
          </div>
          <div className="mt-1 text-sm font-semibold text-txt">{mode}</div>
          <div className="mt-1 text-xs text-muted">
            {status?.grantedCapabilities?.length
              ? status.grantedCapabilities.join(" · ")
              : t("lifeopspanels.noCapabilities", {
                  defaultValue: "No capabilities granted.",
                })}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            onClick={() => void ownerX.connect(mode)}
            disabled={actionPending}
          >
            {actionPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            )}
            {connected
              ? t("lifeopspanels.reconnectOwnerX", {
                  defaultValue: "Reconnect Owner X",
                })
              : t("lifeopspanels.connectOwnerX", {
                  defaultValue: "Connect Owner X",
                })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            onClick={() => void agentX.connect("cloud_managed")}
            disabled={actionPending}
          >
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            {agentConnected
              ? t("lifeopspanels.reconnectAgentX", {
                  defaultValue: "Reconnect Agent X",
                })
              : t("lifeopspanels.connectAgentX", {
                  defaultValue: "Connect Agent X",
                })}
          </Button>
          {connected ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 rounded-xl px-3 text-xs font-semibold"
              onClick={() => void ownerX.disconnect()}
              disabled={actionPending}
            >
              <Unplug className="mr-1.5 h-3.5 w-3.5" />
              {t("lifeopspanels.disconnectOwnerX", {
                defaultValue: "Disconnect Owner",
              })}
            </Button>
          ) : null}
        </div>

        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          className="min-h-[84px] rounded-2xl border-border/20 bg-bg/36 text-sm"
          placeholder={t("lifeopspanels.xPostPlaceholder", {
            defaultValue: "Write an X post",
          })}
        />
        <div className="flex items-center justify-between gap-3">
          {agentX.lastPost ? (
            <div className="text-xs text-muted">
              {agentX.lastPost.postId
                ? `Last post ${agentX.lastPost.postId}.`
                : `Last post status ${agentX.lastPost.status}.`}
            </div>
          ) : null}
          <Button
            size="sm"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={
              !draft.trim() ||
              agentX.actionPending ||
              !agentConnected ||
              !hasAgentWrite
            }
            onClick={handlePost}
          >
            <Send className="mr-1.5 h-3.5 w-3.5" />
            {t("lifeopspanels.post", { defaultValue: "Post" })}
          </Button>
        </div>
      </div>

      {status?.grant ? (
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="text-2xs">
            {status.grant.provider}
          </Badge>
          <Badge variant="outline" className="text-2xs">
            {status.grant.mode}
          </Badge>
          <Badge variant="outline" className="text-2xs">
            {status.grantedScopes.length} scopes
          </Badge>
        </div>
      ) : null}

      {ownerX.pendingAuthUrl || agentX.pendingAuthUrl ? (
        <a
          href={ownerX.pendingAuthUrl ?? agentX.pendingAuthUrl ?? ""}
          target="_blank"
          rel="noreferrer"
          className="text-xs font-medium text-accent hover:underline"
        >
          {t("lifeopspanels.openXAuth", {
            defaultValue: "Open X authorization",
          })}
        </a>
      ) : null}

      {ownerX.error || agentX.error ? (
        <div className="text-xs text-danger">
          {ownerX.error ?? agentX.error}
        </div>
      ) : null}
    </PanelShell>
  );
}

export function LifeOpsStretchPanel() {
  const { t } = useApp();
  const stretch = useLifeOpsStretchReminder();
  const reminder = stretch.stretchReminder;
  const inspection = stretch.inspection;
  const seedLabel = stretch.stretchTemplate
    ? stretch.stretchTemplate.title
    : t("lifeopspanels.stretchTemplateMissing", {
        defaultValue: "Stretch template unavailable",
      });

  return (
    <PanelShell
      title={t("lifeopspanels.stretch", { defaultValue: "Stretch reminder" })}
      icon={<Wand2 className="h-4 w-4 shrink-0 text-muted" />}
      status={
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          onClick={() => void stretch.refresh()}
          disabled={stretch.loading}
        >
          {stretch.loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("lifeopspanels.template", { defaultValue: "Template" })}
          </div>
          <div className="mt-1 text-sm font-semibold text-txt">{seedLabel}</div>
          <div className="mt-1 text-xs text-muted">
            {stretch.stretchTemplate?.description ??
              t("lifeopspanels.templateUnavailable", {
                defaultValue: "No stretch template loaded.",
              })}
          </div>
        </div>
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("lifeopspanels.reminder", { defaultValue: "Reminder" })}
          </div>
          <div className="mt-1 text-sm font-semibold text-txt">
            {reminder?.title ??
              t("lifeopspanels.none", { defaultValue: "None" })}
          </div>
          <div className="mt-1 text-xs text-muted">
            {reminder
              ? `${reminder.stepLabel} · ${reminder.state} · ${formatDateTime(reminder.scheduledFor)}`
              : t("lifeopspanels.noStretchReminder", {
                  defaultValue: "No stretch reminder is active yet.",
                })}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          disabled={stretch.seedPending}
          onClick={() => void stretch.createStretchReminder()}
        >
          {stretch.seedPending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t("lifeopspanels.createStretch", {
            defaultValue: "Create stretch reminder",
          })}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          disabled={!reminder || stretch.inspectionPending}
          onClick={() => void stretch.inspectStretchReminder()}
        >
          <FileText className="mr-1.5 h-3.5 w-3.5" />
          {t("lifeopspanels.inspectReminder", {
            defaultValue: "Inspect reminder",
          })}
        </Button>
      </div>

      {inspection ? (
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2 text-xs text-muted">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("lifeopspanels.inspection", { defaultValue: "Inspection" })}
          </div>
          <div className="mt-1 text-sm font-semibold text-txt">
            {inspection.ownerType} · {inspection.ownerId}
          </div>
          <div className="mt-1">
            {inspection.attempts.length} attempts ·{" "}
            {inspection.reminderPlan
              ? "reminder plan loaded"
              : "no reminder plan"}
          </div>
        </div>
      ) : null}

      {stretch.error ? (
        <div className="text-xs text-danger">{stretch.error}</div>
      ) : null}
    </PanelShell>
  );
}
