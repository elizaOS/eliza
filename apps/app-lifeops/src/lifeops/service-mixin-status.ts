import type { IAgentRuntime, Task } from "@elizaos/core";
import type {
  BrowserBridgeCompanionStatus,
  BrowserBridgeSettings,
} from "../../../../plugins/plugin-browser-bridge/src/index.js";
import type {
  LifeOpsCapabilitiesStatus,
  LifeOpsCapabilityEvidence,
  LifeOpsCapabilityState,
  LifeOpsCapabilityStatus,
  LifeOpsConnectorMode,
  LifeOpsXConnectorStatus,
} from "@elizaos/shared";
import { loadLifeOpsAppState } from "./app-state.js";
import { resolveDefaultTimeZone } from "./defaults.js";
import { createFeatureFlagService } from "./feature-flags.js";
import type { FeatureFlagState } from "./feature-flags.types.js";
import type { HealthBackend } from "./health-bridge.js";
import type { LifeOpsScheduleMergedState } from "./schedule-sync-contracts.js";
import {
  LIFEOPS_TASK_NAME,
  LIFEOPS_TASK_TAGS,
  resolveLifeOpsTaskIntervalMs,
} from "./scheduler-task.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

type HealthConnectorStatus = {
  available: boolean;
  backend: HealthBackend;
  lastCheckedAt: string;
};

export type StatusMixinDependencies = LifeOpsServiceBase & {
  runtime: IAgentRuntime;
  getScheduleMergedState(args?: {
    timezone?: string | null;
    scope?: "local" | "cloud" | "effective";
    refresh?: boolean;
    now?: Date;
  }): Promise<LifeOpsScheduleMergedState | null>;
  getBrowserSettings(): Promise<BrowserBridgeSettings>;
  listBrowserCompanions(): Promise<BrowserBridgeCompanionStatus[]>;
  getXConnectorStatus(
    mode?: LifeOpsConnectorMode,
  ): Promise<LifeOpsXConnectorStatus>;
  getHealthConnectorStatus(): Promise<HealthConnectorStatus>;
};

type CheckResult<T> =
  | { ok: true; value: T; message?: string; observedAt?: string }
  | { ok: false; value?: T; message: string; observedAt: string };

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : String(error);
}

async function runCheck<T>(
  observedAt: string,
  fn: () => Promise<T>,
): Promise<CheckResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, message: errorMessage(error), observedAt };
  }
}

function clampConfidence(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

function minutesLabel(value: number | null): string {
  if (value === null) {
    return "calibrating";
  }
  if (value < 60) {
    return `${value}m`;
  }
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function createCapability(args: {
  id: string;
  domain: LifeOpsCapabilityStatus["domain"];
  label: string;
  state: LifeOpsCapabilityState;
  summary: string;
  confidence: number;
  checkedAt: string;
  evidence: LifeOpsCapabilityEvidence[];
}): LifeOpsCapabilityStatus {
  return {
    id: args.id,
    domain: args.domain,
    label: args.label,
    state: args.state,
    summary: args.summary,
    confidence: clampConfidence(args.confidence),
    lastCheckedAt: args.checkedAt,
    evidence: args.evidence,
  };
}

function featureSummary(features: readonly FeatureFlagState[]): string {
  const enabledCount = features.filter((feature) => feature.enabled).length;
  return `${enabledCount}/${features.length} opt-in features enabled`;
}

function taskMetadataNumber(task: Task | null, key: string): number | null {
  const metadata =
    task?.metadata && typeof task.metadata === "object" ? task.metadata : null;
  const value = metadata ? (metadata as Record<string, unknown>)[key] : null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function findSchedulerTask(tasks: readonly Task[]): Task | null {
  return (
    tasks.find((task) => {
      const tags = Array.isArray(task.tags) ? task.tags : [];
      return (
        task.name === LIFEOPS_TASK_NAME &&
        LIFEOPS_TASK_TAGS.every((tag) => tags.includes(tag))
      );
    }) ?? null
  );
}

function summarizeXStatus(statuses: readonly LifeOpsXConnectorStatus[]): {
  state: LifeOpsCapabilityState;
  summary: string;
  confidence: number;
  evidence: LifeOpsCapabilityEvidence[];
} {
  const connected = statuses.filter((status) => status.connected);
  const credentialed = statuses.filter((status) => status.hasCredentials);
  const evidence = statuses.map(
    (status): LifeOpsCapabilityEvidence => ({
      label: `X ${status.mode}`,
      state: status.connected
        ? "working"
        : status.hasCredentials
          ? "degraded"
          : "not_configured",
      detail:
        status.grantedCapabilities.length > 0
          ? status.grantedCapabilities.join(", ")
          : null,
      observedAt: null,
    }),
  );
  if (connected.length > 0) {
    return {
      state: "working",
      summary: `${connected.length} X account mode connected`,
      confidence: 0.9,
      evidence,
    };
  }
  if (credentialed.length > 0) {
    return {
      state: "degraded",
      summary: "X credentials are present but no account grant is connected",
      confidence: 0.55,
      evidence,
    };
  }
  return {
    state: "not_configured",
    summary: "No X account credentials or grant are configured",
    confidence: 0.35,
    evidence,
  };
}

function summarizeCapabilities(
  capabilities: readonly LifeOpsCapabilityStatus[],
): LifeOpsCapabilitiesStatus["summary"] {
  return {
    totalCount: capabilities.length,
    workingCount: capabilities.filter((item) => item.state === "working")
      .length,
    degradedCount: capabilities.filter((item) => item.state === "degraded")
      .length,
    blockedCount: capabilities.filter((item) => item.state === "blocked")
      .length,
    notConfiguredCount: capabilities.filter(
      (item) => item.state === "not_configured",
    ).length,
  };
}

/** @internal */
export function withStatus<TBase extends Constructor<StatusMixinDependencies>>(
  Base: TBase,
) {
  class LifeOpsStatusServiceMixin extends Base {
    async getCapabilityStatus(
      now = new Date(),
    ): Promise<LifeOpsCapabilitiesStatus> {
      const checkedAt = now.toISOString();
      const timezone = resolveDefaultTimeZone();
      const [
        appState,
        features,
        schedule,
        browserSettings,
        browserCompanions,
        health,
        xLocal,
        xCloud,
        schedulerTasks,
      ] = await Promise.all([
        runCheck(checkedAt, () => loadLifeOpsAppState(this.runtime)),
        runCheck(checkedAt, () =>
          createFeatureFlagService(this.runtime).list(),
        ),
        runCheck(checkedAt, () =>
          this.getScheduleMergedState({
            timezone,
            scope: "effective",
            refresh: false,
            now,
          }),
        ),
        runCheck(checkedAt, () => this.getBrowserSettings()),
        runCheck(checkedAt, () => this.listBrowserCompanions()),
        runCheck(checkedAt, () => this.getHealthConnectorStatus()),
        runCheck(checkedAt, () => this.getXConnectorStatus("local")),
        runCheck(checkedAt, () => this.getXConnectorStatus("cloud_managed")),
        runCheck(checkedAt, () =>
          this.runtime.getTasks({
            agentIds: [this.runtime.agentId],
            tags: [...LIFEOPS_TASK_TAGS],
          }),
        ),
      ]);

      const appEnabled = appState.ok && appState.value.enabled;
      const appStateLoadFailed = !appState.ok;
      const appDisabled = appState.ok && !appState.value.enabled;
      const scheduleState = schedule.ok ? schedule.value : null;
      const featureStates = features.ok ? features.value : [];
      const browser =
        browserSettings.ok && browserCompanions.ok
          ? {
              settings: browserSettings.value,
              companions: browserCompanions.value,
            }
          : null;
      const xStatuses = [xLocal, xCloud]
        .filter(
          (
            result,
          ): result is CheckResult<LifeOpsXConnectorStatus> & { ok: true } =>
            result.ok,
        )
        .map((result) => result.value);

      const workerRegistered = Boolean(
        this.runtime.getTaskWorker?.(LIFEOPS_TASK_NAME),
      );
      const schedulerTask = schedulerTasks.ok
        ? findSchedulerTask(schedulerTasks.value)
        : null;
      const schedulerIntervalMs =
        taskMetadataNumber(schedulerTask, "updateInterval") ??
        resolveLifeOpsTaskIntervalMs(this.runtime.agentId);

      const capabilities: LifeOpsCapabilityStatus[] = [
        createCapability({
          id: "lifeops.app",
          domain: "core",
          label: "LifeOps runtime",
          state: appStateLoadFailed
            ? "degraded"
            : appEnabled
              ? "working"
              : "blocked",
          summary: appStateLoadFailed
            ? "LifeOps app state could not be loaded"
            : appEnabled
              ? "LifeOps is enabled for the owner"
              : "LifeOps is disabled by the owner toggle",
          confidence: appState.ok ? 0.95 : 0.5,
          checkedAt,
          evidence: [
            {
              label: "App toggle",
              state: appStateLoadFailed
                ? "degraded"
                : appEnabled
                  ? "working"
                  : "blocked",
              detail: appState.ok ? null : appState.message,
              observedAt: appState.ok ? checkedAt : appState.observedAt,
            },
          ],
        }),
        createCapability({
          id: "sleep.relative_time",
          domain: "schedule",
          label: "Awake-relative time",
          state: scheduleState
            ? scheduleState.relativeTime.circadianState === "awake" ||
              scheduleState.relativeTime.circadianState === "waking" ||
              scheduleState.relativeTime.circadianState === "sleeping" ||
              scheduleState.relativeTime.circadianState === "napping"
              ? "working"
              : "degraded"
            : "not_configured",
          summary: scheduleState
            ? `${scheduleState.relativeTime.circadianState}; ${
                scheduleState.relativeTime.circadianState === "awake"
                  ? `awake ${minutesLabel(scheduleState.relativeTime.minutesAwake)}`
                  : scheduleState.relativeTime.circadianState
              }; bedtime ${
                scheduleState.relativeTime.minutesUntilBedtimeTarget !== null
                  ? `in ${minutesLabel(
                      scheduleState.relativeTime.minutesUntilBedtimeTarget,
                    )}`
                  : scheduleState.relativeTime.minutesSinceBedtimeTarget !==
                      null
                    ? `${minutesLabel(
                        scheduleState.relativeTime.minutesSinceBedtimeTarget,
                      )} ago`
                    : "calibrating"
              }`
            : "No schedule projection is available yet",
          confidence: scheduleState?.relativeTime.confidence ?? 0.2,
          checkedAt,
          evidence: [
            {
              label: "Schedule projection",
              state:
                schedule.ok && scheduleState ? "working" : "not_configured",
              detail: schedule.ok
                ? scheduleState
                  ? `${scheduleState.observationCount} observations across ${scheduleState.deviceCount} devices`
                  : "No merged schedule state"
                : schedule.message,
              observedAt: scheduleState?.relativeTime.computedAt ?? checkedAt,
            },
            {
              label: "Health sleep source",
              state: health.ok
                ? health.value.available
                  ? "working"
                  : "not_configured"
                : "degraded",
              detail: health.ok ? health.value.backend : health.message,
              observedAt: health.ok
                ? health.value.lastCheckedAt
                : health.observedAt,
            },
          ],
        }),
        createCapability({
          id: "reminders.scheduler",
          domain: "reminders",
          label: "Reminder scheduler",
          state: appDisabled
            ? "blocked"
            : appStateLoadFailed
              ? "degraded"
            : workerRegistered && schedulerTask
              ? "working"
              : "degraded",
          summary: appDisabled
            ? "Scheduler is intentionally suppressed while LifeOps is disabled"
            : appStateLoadFailed
              ? "Scheduler status is degraded because LifeOps app state failed to load"
            : workerRegistered && schedulerTask
              ? `Worker registered; interval ${Math.round(
                  schedulerIntervalMs / 1000,
                )}s`
              : "Scheduler worker or task row is missing",
          confidence: workerRegistered && schedulerTask ? 0.88 : 0.45,
          checkedAt,
          evidence: [
            {
              label: "Task worker",
              state: workerRegistered ? "working" : "degraded",
              detail: LIFEOPS_TASK_NAME,
              observedAt: checkedAt,
            },
            {
              label: "Task row",
              state: schedulerTask ? "working" : "degraded",
              detail: schedulerTasks.ok
                ? (schedulerTask?.id ?? "No scheduler task row")
                : schedulerTasks.message,
              observedAt: checkedAt,
            },
          ],
        }),
        createCapability({
          id: "activity.browser",
          domain: "activity",
          label: "Browser activity",
          state: browser
            ? browser.settings.enabled &&
              browser.settings.trackingMode !== "off"
              ? "working"
              : "not_configured"
            : "degraded",
          summary: browser
            ? `${browser.settings.trackingMode} tracking; ${browser.companions.length} companions`
            : "Browser status failed to load",
          confidence: browser ? 0.75 : 0.3,
          checkedAt,
          evidence: [
            {
              label: "Browser settings",
              state: browser
                ? browser.settings.enabled
                  ? "working"
                  : "not_configured"
                : "degraded",
              detail: browser
                ? `site access ${browser.settings.siteAccessMode}`
                : browserSettings.ok
                  ? "Missing browser companions"
                  : browserSettings.message,
              observedAt: browser?.settings.updatedAt ?? checkedAt,
            },
          ],
        }),
        createCapability({
          id: "features.opt_in",
          domain: "core",
          label: "Feature gates",
          state: features.ok ? "working" : "degraded",
          summary: features.ok
            ? featureSummary(featureStates)
            : "Feature flags failed to load",
          confidence: features.ok ? 0.85 : 0.3,
          checkedAt,
          evidence: [
            {
              label: "Feature flag store",
              state: features.ok ? "working" : "degraded",
              detail: features.ok
                ? featureSummary(featureStates)
                : features.message,
              observedAt: checkedAt,
            },
          ],
        }),
      ];

      const xSummary =
        xStatuses.length > 0
          ? summarizeXStatus(xStatuses)
          : {
              state: "degraded" as const,
              summary: "X status failed to load",
              confidence: 0.2,
              evidence: [
                {
                  label: "X status",
                  state: "degraded" as const,
                  detail: xLocal.ok
                    ? xCloud.ok
                      ? null
                      : xCloud.message
                    : xLocal.message,
                  observedAt: checkedAt,
                },
              ],
            };
      capabilities.push(
        createCapability({
          id: "connectors.x",
          domain: "connectors",
          label: "X account",
          state: xSummary.state,
          summary: xSummary.summary,
          confidence: xSummary.confidence,
          checkedAt,
          evidence: xSummary.evidence,
        }),
      );

      return {
        generatedAt: checkedAt,
        appEnabled,
        relativeTime: scheduleState?.relativeTime ?? null,
        capabilities,
        summary: summarizeCapabilities(capabilities),
      };
    }
  }

  return LifeOpsStatusServiceMixin;
}
