import {
  Badge,
  Button,
  Textarea,
  useApp,
} from "@elizaos/app-core";
import {
  type LifeOpsConnectorMode,
  type LifeOpsXConnectorStatus,
} from "@elizaos/shared/contracts/lifeops";
import { Clock3, FileText, Loader2, RefreshCw, Send, Sparkles, UserRound, Wand2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
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
          <div className="mt-1 text-sm font-semibold text-txt">{sleepLabel}</div>
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
            {t("lifeopspanels.relativeTime", {
              defaultValue: "Relative time",
            })}
          </div>
          <div className="mt-1 text-sm font-semibold text-txt">
            {merged
              ? t("lifeopspanels.relativePhase", {
                  defaultValue: "{{phase}} · woke {{duration}} ago",
                  phase: merged.relativeTime.phase,
                  duration: formatMinutes(merged.relativeTime.minutesSinceWake),
                })
              : "—"}
          </div>
          <div className="mt-1 text-xs text-muted">
            {merged?.relativeTime.bedtimeTargetAt
              ? t("lifeopspanels.bedtimeTarget", {
                  defaultValue: "Bedtime target {{time}} · in {{duration}}",
                  time: formatDateTime(merged.relativeTime.bedtimeTargetAt),
                  duration: formatMinutes(
                    merged.relativeTime.minutesUntilBedtimeTarget,
                  ),
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
          <div className="mt-1 text-xs text-muted">
            {merged?.wakeAt ? `Wake target ${formatDateTime(merged.wakeAt)}` : " "}
            {merged?.lastSleepDurationMinutes
              ? ` ${Math.round(merged.lastSleepDurationMinutes)} min last sleep`
              : ""}
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
  const x = useLifeOpsXConnector();
  const [draft, setDraft] = useState("");
  const status = x.status;
  const connected = status?.connected === true;
  const hasWrite = status?.grantedCapabilities.includes("x.write") === true;
  const identity = readXIdentity(
    status?.identity ?? null,
    t("lifeopspanels.notConnected", { defaultValue: "Not connected" }),
  );
  const mode = status?.mode ?? "local";
  const missingRoutes = true;

  const handlePost = useCallback(() => {
    const text = draft.trim();
    if (!text) {
      return;
    }
    void x.post(text).then(() => setDraft(""));
  }, [draft, x]);

  return (
    <PanelShell
      title={t("lifeopspanels.xAccount", { defaultValue: "X account" })}
      icon={<Sparkles className="h-4 w-4 shrink-0 text-muted" />}
      status={
        <div className="flex items-center gap-2">
          <Badge variant={connected ? "secondary" : "outline"} className="text-2xs">
            {connected
              ? t("lifeopspanels.connected", { defaultValue: "Connected" })
              : t("lifeopspanels.disconnected", { defaultValue: "Disconnected" })}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            onClick={() => void x.refresh()}
            disabled={x.loading}
          >
            {x.loading ? (
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
                  defaultValue: "Credentials present.",
                })
              : t("lifeopspanels.credentialsMissing", {
                  defaultValue: "Credentials missing.",
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
            onClick={() => void x.connect(mode)}
            disabled={x.actionPending}
          >
            {x.actionPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            )}
            {connected
              ? t("lifeopspanels.reconnectX", { defaultValue: "Reconnect X" })
              : t("lifeopspanels.connectX", { defaultValue: "Connect X" })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled
            title="No HTTP route is exposed for X digest yet."
          >
            {t("lifeopspanels.readDigest", {
              defaultValue: "Read digest",
            })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled
            title="No HTTP route is exposed for X curation yet."
          >
            {t("lifeopspanels.curateFeed", {
              defaultValue: "Curate feed",
            })}
          </Button>
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
          <div className="text-xs text-muted">
            {missingRoutes
              ? "Digest and curation backend routes are missing."
              : ""}
            {x.lastPost?.postId
              ? ` Last post ${x.lastPost.postId}.`
              : x.lastPost
                ? ` Last post status ${x.lastPost.status}.`
                : ""}
          </div>
          <Button
            size="sm"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={!draft.trim() || x.actionPending || !connected || !hasWrite}
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

      {x.error ? <div className="text-xs text-danger">{x.error}</div> : null}
    </PanelShell>
  );
}

export function LifeOpsProfilePanel() {
  const { t } = useApp();
  return (
    <PanelShell
      title={t("lifeopspanels.profile", { defaultValue: "Profile" })}
      icon={<UserRound className="h-4 w-4 shrink-0 text-muted" />}
      status={
        <Badge variant="outline" className="text-2xs">
          Missing route
        </Badge>
      }
    >
      <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2 text-xs text-muted">
        {t("lifeopspanels.profileMissing", {
          defaultValue:
            "No dashboard HTTP endpoint exists for owner profile read/load yet.",
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          disabled
          title="No profile read route exists yet."
        >
          {t("lifeopspanels.readProfile", { defaultValue: "Read profile" })}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          disabled
          title="No profile load route exists yet."
        >
          {t("lifeopspanels.loadProfile", { defaultValue: "Load profile" })}
        </Button>
      </div>
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
            {reminder?.title ?? t("lifeopspanels.none", { defaultValue: "None" })}
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
            {inspection.reminderPlan ? "reminder plan loaded" : "no reminder plan"}
          </div>
        </div>
      ) : null}

      {stretch.error ? <div className="text-xs text-danger">{stretch.error}</div> : null}
    </PanelShell>
  );
}
