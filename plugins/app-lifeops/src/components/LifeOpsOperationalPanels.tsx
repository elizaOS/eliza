import {
  Badge,
  Button,
  client,
  useApp,
} from "@elizaos/ui";
import { dispatchFocusConnector } from "@elizaos/ui/events";
import type {
  LifeOpsCapabilityState,
  LifeOpsManualOverrideKind,
} from "@elizaos/shared";
import {
  Activity,
  Clock3,
  Loader2,
  Moon,
  RefreshCw,
  Sparkles,
  Sun,
  Unplug,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { useLifeOpsCapabilitiesStatus } from "../hooks/useLifeOpsCapabilitiesStatus.js";
import { useLifeOpsScheduleState } from "../hooks/useLifeOpsScheduleState.js";
import { useLifeOpsXConnector } from "../hooks/useLifeOpsXConnector.js";
import { SleepInspectionPanel } from "./SleepInspectionPanel.js";

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

function StatusDot({
  connected,
  label,
}: {
  connected: boolean;
  label: string;
}) {
  return (
    <span
      aria-label={label}
      className={`inline-block h-2.5 w-2.5 rounded-full ${
        connected
          ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.14)]"
          : "bg-muted/45"
      }`}
      role="img"
      title={label}
    />
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
      {status ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-muted">
              {t("lifeopspanels.capabilityHealth", {
                defaultValue: "Health",
              })}
            </div>
            <div className="mt-1 text-sm font-semibold text-txt">
              {`${status.summary.workingCount}/${status.summary.totalCount} working`}
            </div>
            <div className="mt-1 text-xs text-muted">
              {status.summary.degradedCount} degraded ·{" "}
              {status.summary.blockedCount} blocked
            </div>
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
            {status.relativeTime ? (
              <div className="mt-1 text-xs text-muted">
                Computed {formatDateTime(status.relativeTime.computedAt)}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2 text-sm font-semibold text-txt">
          {capabilities.error ? (
            <span className="text-danger">{capabilities.error}</span>
          ) : (
            t("common.loading", { defaultValue: "Loading" })
          )}
        </div>
      )}

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

      {capabilities.error && status ? (
        <div className="text-xs text-danger">{capabilities.error}</div>
      ) : null}
    </PanelShell>
  );
}

export function LifeOpsSchedulePanel() {
  const { t } = useApp();
  const schedule = useLifeOpsScheduleState({ scope: "effective" });
  const [manualOverrideKind, setManualOverrideKind] =
    useState<LifeOpsManualOverrideKind | null>(null);
  const [manualOverrideError, setManualOverrideError] = useState<string | null>(
    null,
  );
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
          defaultValue: "{{state}} · woke {{duration}} ago",
          state: merged.relativeTime.circadianState,
          duration: formatMinutes(merged.relativeTime.minutesAwake),
        })
      : merged
        ? t("lifeopspanels.relativePhaseCalibrating", {
            defaultValue: "{{state}} · {{confidence}}% confidence",
            state: merged.relativeTime.circadianState,
            confidence: Math.round(merged.relativeTime.stateConfidence * 100),
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

  const captureManualOverride = useCallback(
    async (kind: LifeOpsManualOverrideKind) => {
      setManualOverrideKind(kind);
      setManualOverrideError(null);
      try {
        await client.captureLifeOpsManualOverride({ kind });
        await schedule.refresh();
      } catch (cause) {
        setManualOverrideError(
          cause instanceof Error
            ? cause.message
            : t("lifeopspanels.manualOverrideFailed", {
                defaultValue: "Manual schedule update failed.",
              }),
        );
      } finally {
        setManualOverrideKind(null);
      }
    },
    [schedule.refresh, t],
  );

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
      {merged ? (
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
              {`${merged.circadianState} · ${formatPercent(merged.sleepConfidence)} confidence${
                merged.uncertaintyReason ? ` · ${merged.uncertaintyReason}` : ""
              }`}
            </div>
          </div>
          <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-muted">
              {t("lifeopspanels.awakeProbability", {
                defaultValue: "Awake probability",
              })}
            </div>
            <div className="mt-1 text-sm font-semibold text-txt">
              {`${formatPercent(merged.awakeProbability.pAwake)} awake · ${formatPercent(merged.awakeProbability.pAsleep)} asleep`}
            </div>
            <div className="mt-1 text-xs text-muted">
              {`${formatPercent(merged.awakeProbability.pUnknown)} unknown · state ${merged.circadianState} (${formatPercent(merged.stateConfidence)})`}
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
              {merged.relativeTime.bedtimeTargetAt
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
              {merged.currentSleepStartedAt
                ? `Started ${formatDateTime(merged.currentSleepStartedAt)}`
                : merged.lastSleepStartedAt
                  ? `Last started ${formatDateTime(merged.lastSleepStartedAt)}`
                  : "—"}
            </div>
            {merged.wakeAt || merged.lastSleepDurationMinutes ? (
              <div className="mt-1 text-xs text-muted">
                {merged.wakeAt
                  ? `Wake target ${formatDateTime(merged.wakeAt)}`
                  : null}
                {merged.lastSleepDurationMinutes
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
              {`${merged.regularity.regularityClass.replace(/_/g, " ")} · SRI ${Math.round(merged.regularity.sri)}`}
            </div>
            <div className="mt-1 text-xs text-muted">
              {`${Math.round(merged.regularity.bedtimeStddevMin)}m bedtime stddev · ${Math.round(merged.regularity.wakeStddevMin)}m wake stddev`}
            </div>
          </div>
          {merged.baseline ? (
            <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-muted">
                {t("lifeopspanels.baseline", {
                  defaultValue: "Personal baseline",
                })}
              </div>
              <div className="mt-1 text-sm font-semibold text-txt">
                {`Wake ~${merged.baseline.medianWakeLocalHour.toFixed(1)}h · Bed ~${(merged.baseline.medianBedtimeLocalHour % 24).toFixed(1)}h`}
              </div>
              <div className="mt-1 text-xs text-muted">
                {`${merged.baseline.sampleCount} episodes · ${Math.round(merged.baseline.medianSleepDurationMin)}m median sleep · ${merged.baseline.windowDays}d window`}
              </div>
            </div>
          ) : null}
          {merged.awakeProbability.contributingSources.length > 0 ? (
            <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2 sm:col-span-2">
              <div className="text-[11px] uppercase tracking-wide text-muted">
                {t("lifeopspanels.contributingSources", {
                  defaultValue: "Contributing evidence",
                })}
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {merged.awakeProbability.contributingSources
                  .slice(0, 8)
                  .map((contributor) => {
                    const llr = contributor.logLikelihoodRatio;
                    const tone =
                      llr > 0
                        ? "bg-emerald-500/14 text-emerald-300"
                        : "bg-amber-500/14 text-amber-300";
                    return (
                      <span
                        key={`${contributor.source}:${llr.toFixed(4)}`}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${tone}`}
                      >
                        {`${contributor.source}: ${llr >= 0 ? "+" : ""}${llr.toFixed(2)}`}
                      </span>
                    );
                  })}
              </div>
            </div>
          ) : null}
          {merged.circadianRuleFirings.length > 0 ? (
            <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2 sm:col-span-2">
              <div className="text-[11px] uppercase tracking-wide text-muted">
                {t("lifeopspanels.circadianRules", {
                  defaultValue: "Rules that fired",
                })}
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {merged.circadianRuleFirings.slice(0, 8).map((firing) => {
                  const tone =
                    firing.contributes === "awake" ||
                    firing.contributes === "waking"
                      ? "bg-sky-500/14 text-sky-300"
                      : firing.contributes === "sleeping" ||
                          firing.contributes === "napping"
                        ? "bg-violet-500/14 text-violet-300"
                        : "bg-amber-500/14 text-amber-300";
                  return (
                    <span
                      key={`${firing.name}:${firing.observedAt}`}
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${tone}`}
                      title={firing.reason}
                    >
                      {`${firing.name} -> ${firing.contributes} (${firing.weight.toFixed(2)})`}
                    </span>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2 text-sm font-semibold text-txt">
          {t("common.loading", { defaultValue: "Loading" })}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          onClick={() => void captureManualOverride("just_woke_up")}
          disabled={manualOverrideKind !== null}
        >
          {manualOverrideKind === "just_woke_up" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sun className="h-3.5 w-3.5" />
          )}
          {t("lifeopspanels.justWokeUp", { defaultValue: "Just woke up" })}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          onClick={() => void captureManualOverride("going_to_bed")}
          disabled={manualOverrideKind !== null}
        >
          {manualOverrideKind === "going_to_bed" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Moon className="h-3.5 w-3.5" />
          )}
          {t("lifeopspanels.goingToBed", { defaultValue: "Going to bed" })}
        </Button>
        {manualOverrideError ? (
          <span className="self-center text-xs text-danger">
            {manualOverrideError}
          </span>
        ) : null}
      </div>
      {merged ? <SleepInspectionPanel /> : null}
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
  const { setActionNotice, setTab, t } = useApp();
  const ownerX = useLifeOpsXConnector("owner");
  const agentX = useLifeOpsXConnector("agent");
  const status = ownerX.status;
  const agentStatus = agentX.status;
  const connected = status?.connected === true;
  const agentConnected = agentStatus?.connected === true;
  const ownerIdentity = readXIdentity(status?.identity ?? null, "");
  const agentIdentity = readXIdentity(agentStatus?.identity ?? null, "");
  const actionPending = ownerX.actionPending || agentX.actionPending;

  const openXConnectorSettings = useCallback(() => {
    setTab("connectors");
    dispatchFocusConnector("x");
    setActionNotice(
      "X account setup is managed in Connectors. Configure plugin-x there, then refresh LifeOps.",
      "info",
      4200,
    );
  }, [setActionNotice, setTab]);

  const handleOwnerConnect = useCallback(() => {
    if (!connected) {
      openXConnectorSettings();
      return;
    }
    void ownerX.connect("local");
  }, [connected, openXConnectorSettings, ownerX.connect]);

  const handleAgentConnect = useCallback(() => {
    if (!agentConnected) {
      openXConnectorSettings();
      return;
    }
    void agentX.connect("local");
  }, [agentConnected, agentX.connect, openXConnectorSettings]);

  return (
    <PanelShell
      title={t("lifeopspanels.xAccount", { defaultValue: "X" })}
      icon={<Sparkles className="h-4 w-4 shrink-0 text-muted" />}
      status={
        <div className="flex items-center gap-2">
          <StatusDot
            connected={connected}
            label={
              connected
                ? t("lifeopspanels.connected", { defaultValue: "Connected" })
                : t("lifeopspanels.disconnected", {
                    defaultValue: "Disconnected",
                  })
            }
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 rounded-xl p-0"
            onClick={() => {
              void ownerX.refresh();
              void agentX.refresh();
            }}
            disabled={ownerX.loading || agentX.loading}
            title={t("common.refresh", { defaultValue: "Refresh" })}
            aria-label={t("common.refresh", { defaultValue: "Refresh" })}
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
            {t("lifeopspanels.owner", { defaultValue: "Owner" })}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <StatusDot
              connected={connected}
              label={
                connected
                  ? t("lifeopspanels.connected", { defaultValue: "Connected" })
                  : t("lifeopspanels.disconnected", {
                      defaultValue: "Disconnected",
                    })
              }
            />
            {ownerIdentity ? (
              <div className="min-w-0 truncate text-sm font-semibold text-txt">
                {ownerIdentity}
              </div>
            ) : null}
          </div>
        </div>
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("chat.agentType", { defaultValue: "Agent" })}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <StatusDot
              connected={agentConnected}
              label={
                agentConnected
                  ? t("lifeopspanels.connected", { defaultValue: "Connected" })
                  : t("lifeopspanels.disconnected", {
                      defaultValue: "Disconnected",
                    })
              }
            />
            {agentIdentity ? (
              <div className="min-w-0 truncate text-sm font-semibold text-txt">
                {agentIdentity}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          onClick={handleOwnerConnect}
          disabled={actionPending}
          title={
            connected
              ? t("lifeopspanels.reconnectOwnerX", {
                  defaultValue: "Reconnect Owner X",
                })
              : t("lifeopspanels.connectOwnerX", {
                  defaultValue: "Connect Owner X",
                })
          }
        >
          {actionPending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t("lifeopspanels.owner", { defaultValue: "Owner" })}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          onClick={handleAgentConnect}
          disabled={actionPending}
          title={
            agentConnected
              ? t("lifeopspanels.reconnectAgentX", {
                  defaultValue: "Reconnect Agent X",
                })
              : t("lifeopspanels.connectAgentX", {
                  defaultValue: "Connect Agent X",
                })
          }
        >
          {actionPending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t("chat.agentType", { defaultValue: "Agent" })}
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

      {ownerX.error || agentX.error ? (
        <div className="text-xs text-danger">
          {ownerX.error ?? agentX.error}
        </div>
      ) : null}
    </PanelShell>
  );
}
