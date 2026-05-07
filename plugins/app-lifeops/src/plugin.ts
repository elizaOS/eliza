import {
  getDefaultTriageService,
  type IAgentRuntime,
  logger,
  type Plugin,
  registerSendPolicy,
} from "@elizaos/core";
import { manageBrowserBridgeAction } from "./action.ts";
import { appBlockAction } from "./actions/app-block.js";
import { autofillAction } from "./actions/autofill.js";
import { bookTravelAction } from "./actions/book-travel.js";
import { calendarAction } from "./actions/calendar.js";
import { chatThreadAction } from "./actions/chat-thread.js";
import { checkinAction } from "./actions/checkin.js";
import { computerUseAction } from "./actions/computer-use.js";
import { connectorAction } from "./actions/connector.js";
import { deviceIntentAction } from "./actions/device-intent.js";
import { healthAction } from "./actions/health.js";
import { lifeAction } from "./actions/life.js";
import { passwordManagerAction } from "./actions/password-manager.js";
import { paymentsAction } from "./actions/payments.js";
import { profileAction } from "./actions/profile.js";
import { relationshipAction } from "./actions/relationship.js";
import { remoteDesktopAction } from "./actions/remote-desktop.js";
import { resolveRequestAction } from "./actions/resolve-request.js";
import { scheduleAction } from "./actions/schedule.js";
import { screenTimeAction } from "./actions/screen-time.js";
import { subscriptionsAction } from "./actions/subscriptions.js";
import { toggleFeatureAction } from "./actions/toggle-feature.js";
import { voiceCallAction } from "./actions/voice-call.js";
import { websiteBlockAction } from "./actions/website-block.js";
import { xAction } from "./actions/x.js";
import { ActivityTrackerService } from "./activity-profile/activity-tracker-service.js";
import { PresenceSignalBridgeService } from "./activity-profile/presence-signal-bridge-service.js";
import {
  ensureProactiveAgentTask,
  PROACTIVE_TASK_NAME,
  registerProactiveTaskWorker,
} from "./activity-profile/proactive-worker.js";
import {
  ensureFollowupTrackerTask,
  FOLLOWUP_TRACKER_TASK_NAME,
  registerFollowupTrackerWorker,
} from "./followup/index.js";
import { BrowserBridgeAdapter } from "./lifeops/messaging/adapters/browser-bridge-adapter.js";
import { CalendlyAdapter } from "./lifeops/messaging/adapters/calendly-adapter.js";
import { XDmAdapter } from "./lifeops/messaging/adapters/x-dm-adapter.js";
import { createOwnerSendPolicy } from "./lifeops/messaging/owner-send-policy.js";
import { LifeOpsRepository } from "./lifeops/repository.js";
// LifeOps runtime (scheduler task worker + registration)
import {
  ensureLifeOpsSchedulerTask,
  LIFEOPS_TASK_NAME,
  registerLifeOpsTaskWorker,
} from "./lifeops/runtime.js";
import { lifeOpsSchema } from "./lifeops/schema.js";
import { browserBridgeProvider } from "./provider.ts";
// Activity-profile (proactive agent: GM/GN/nudges)
import { activityProfileProvider } from "./providers/activity-profile.js";
import { appBlockerProvider } from "./providers/app-blocker.js";
import { crossChannelContextProvider } from "./providers/cross-channel-context.js";

// LifeOps core providers
import { healthProvider } from "./providers/health.js";
import { inboxTriageProvider } from "./providers/inbox-triage.js";
import { lifeOpsProvider } from "./providers/lifeops.js";
import { websiteBlockerProvider } from "./providers/website-blocker.js";
import { BrowserBridgePluginService } from "./service.ts";
import {
  blockUntilTaskCompleteAction,
  listActiveBlocksAction,
  registerBlockRuleReconcilerWorker,
  releaseBlockAction,
} from "./website-blocker/chat-integration/index.js";
import {
  getSelfControlStatus,
  type SelfControlPluginConfig,
  setSelfControlPluginConfig,
} from "./website-blocker/engine.js";
import { WebsiteBlockerService } from "./website-blocker/service.js";

async function ensureTaskWithRetries(args: {
  runtime: IAgentRuntime;
  prefix: string;
  label: string;
  ensure: () => Promise<unknown>;
  delays?: readonly number[];
}): Promise<void> {
  const isRuntimeStopped = () =>
    (args.runtime as IAgentRuntime & { stopped?: boolean }).stopped === true;
  const delays = args.delays ?? [2_000, 5_000, 10_000];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (isRuntimeStopped()) {
      return;
    }
    try {
      await args.ensure();
      return;
    } catch (error) {
      if (isRuntimeStopped()) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < delays.length) {
        args.runtime.logger?.warn?.(
          `${args.prefix} ${args.label} init failed (attempt ${attempt + 1}/${delays.length + 1}), retrying in ${delays[attempt]}ms: ${message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        continue;
      }
      args.runtime.logger?.error?.(
        `${args.prefix} ${args.label} init failed after ${delays.length + 1} attempts: ${message}`,
      );
      throw error instanceof Error
        ? error
        : new Error(`${args.label} init failed: ${message}`);
    }
  }
}

function isDisabledByEnv(disableKey: string, enableKey?: string): boolean {
  const disableValue = (process.env[disableKey] ?? "").trim().toLowerCase();
  if (
    disableValue === "1" ||
    disableValue === "true" ||
    disableValue === "yes"
  ) {
    return true;
  }

  if (!enableKey) {
    return false;
  }

  const enableValue = (process.env[enableKey] ?? "").trim().toLowerCase();
  return enableValue === "0" || enableValue === "false";
}

const LIFEOPS_TASK_INIT_FAILURE_CACHE_KEY =
  "eliza:lifeops:plugin:init-failures";

async function recordTaskInitFailure(
  runtime: IAgentRuntime,
  label: string,
  message: string,
): Promise<void> {
  try {
    const existing =
      (await runtime.getCache<Record<string, string>>(
        LIFEOPS_TASK_INIT_FAILURE_CACHE_KEY,
      )) ?? {};
    existing[label] = message;
    await runtime.setCache(LIFEOPS_TASK_INIT_FAILURE_CACHE_KEY, existing);
  } catch {
    // Cache not available; the logger.error is the primary signal.
  }
}

/**
 * Kick off task registration AFTER `runtime.initPromise` resolves — this step
 * cannot be awaited inside `init()` because `init()` runs before the runtime
 * itself has finished initializing. That means failures here are NOT fatal
 * to plugin load; the plugin reports as "loaded" and the specific task
 * subsystem reports as "unavailable". The failure is surfaced via the
 * runtime cache at LIFEOPS_TASK_INIT_FAILURE_CACHE_KEY for observability and
 * via logger.error so ops tooling can alert on it.
 */
function scheduleTaskEnsureAfterRuntimeInit(args: {
  runtime: IAgentRuntime;
  prefix: string;
  label: string;
  ensure: () => Promise<unknown>;
  delays?: readonly number[];
}): void {
  void args.runtime.initPromise
    .then(async () => {
      if (
        (args.runtime as IAgentRuntime & { stopped?: boolean }).stopped === true
      ) {
        return;
      }
      await ensureTaskWithRetries(args);
    })
    .catch((error) => {
      if (
        (args.runtime as IAgentRuntime & { stopped?: boolean }).stopped === true
      ) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      args.runtime.logger?.error?.(
        `${args.prefix} ${args.label} init failed after runtime initialization (plugin stays loaded, this subsystem is degraded): ${message}`,
      );
      void recordTaskInitFailure(args.runtime, args.label, message);
    });
}

const rawAppLifeOpsPlugin: Plugin = {
  name: "@elizaos/app-lifeops",
  description:
    "LifeOps: routines, goals, Google Workspace, Apple Reminders, Twilio, browser companions (Chrome/Safari), website blocking, app blocking, and related surfaces.",
  schema: lifeOpsSchema,
  actions: [
    manageBrowserBridgeAction,
    websiteBlockAction,
    blockUntilTaskCompleteAction,
    listActiveBlocksAction,
    releaseBlockAction,
    appBlockAction,
    calendarAction,
    xAction,
    resolveRequestAction,
    lifeAction,
    bookTravelAction,
    profileAction,
    checkinAction,
    relationshipAction,
    screenTimeAction,
    voiceCallAction,
    remoteDesktopAction,
    computerUseAction,
    scheduleAction,
    deviceIntentAction,
    passwordManagerAction,
    autofillAction,
    healthAction,
    subscriptionsAction,
    paymentsAction,
    chatThreadAction,
    connectorAction,
    toggleFeatureAction,
  ],
  providers: [
    browserBridgeProvider,
    websiteBlockerProvider,
    appBlockerProvider,
    lifeOpsProvider,
    healthProvider,
    inboxTriageProvider,
    crossChannelContextProvider,
    activityProfileProvider,
  ],
  services: [
    BrowserBridgePluginService,
    WebsiteBlockerService,
    ActivityTrackerService,
    PresenceSignalBridgeService,
  ],
  init: async (
    pluginConfig: Record<string, unknown>,
    runtime: IAgentRuntime,
  ) => {
    setSelfControlPluginConfig(pluginConfig as SelfControlPluginConfig);
    const status = await getSelfControlStatus();

    if (status.available) {
      logger.info(
        `[selfcontrol] Hosts-file blocker ready${status.active && status.endsAt ? ` until ${status.endsAt}` : status.active ? " until manually unblocked" : ""}`,
      );
    } else {
      logger.warn(
        `[selfcontrol] Plugin loaded, but local website blocking is unavailable: ${status.reason ?? "unknown reason"}`,
      );
    }

    // Owner outbound-message approval policy: gmail drafts require explicit
    // owner approval; everything else passes straight through.
    registerSendPolicy(runtime, createOwnerSendPolicy());

    // First-party adapters that aren't part of core's built-in set: X DMs
    // (overrides the built-in Twitter adapter), Calendly, and the
    // browser-bridge.
    const triage = getDefaultTriageService();
    triage.register(new XDmAdapter());
    triage.register(new CalendlyAdapter());
    triage.register(new BrowserBridgeAdapter());

    // Register the proactive activity-profile task worker.
    const proactiveAgentDisabled = isDisabledByEnv(
      "ELIZA_DISABLE_PROACTIVE_AGENT",
      "ENABLE_PROACTIVE_AGENT",
    );
    if (!proactiveAgentDisabled) {
      registerProactiveTaskWorker(runtime);
      scheduleTaskEnsureAfterRuntimeInit({
        runtime,
        prefix: "[proactive]",
        label: "task",
        ensure: async () => {
          await ensureProactiveAgentTask(runtime);
        },
      });
    } else {
      runtime.logger?.info(
        "[proactive] Proactive agent task skipped — ELIZA_DISABLE_PROACTIVE_AGENT=1",
      );
    }

    // Register the follow-up tracker worker.
    registerFollowupTrackerWorker(runtime);
    scheduleTaskEnsureAfterRuntimeInit({
      runtime,
      prefix: "[followup-tracker]",
      label: "task",
      ensure: async () => {
        await ensureFollowupTrackerTask(runtime);
      },
    });

    registerBlockRuleReconcilerWorker(runtime);
    scheduleTaskEnsureAfterRuntimeInit({
      runtime,
      prefix: "[lifeops]",
      label: "inbox cache schema",
      ensure: async () => {
        await LifeOpsRepository.ensureInboxCacheIndexes(runtime);
      },
    });

    const lifeOpsSchedulerDisabled = isDisabledByEnv(
      "ELIZA_DISABLE_LIFEOPS_SCHEDULER",
      "ENABLE_LIFEOPS_SCHEDULER",
    );
    if (!lifeOpsSchedulerDisabled) {
      registerLifeOpsTaskWorker(runtime);
      scheduleTaskEnsureAfterRuntimeInit({
        runtime,
        prefix: "[lifeops]",
        label: "scheduler task",
        ensure: async () => {
          await ensureLifeOpsSchedulerTask(runtime);
        },
      });
    } else {
      runtime.logger?.info(
        "[lifeops] Scheduler task skipped — ELIZA_DISABLE_LIFEOPS_SCHEDULER=1",
      );
    }
  },
  /**
   * Tear down everything `init` registered so `runtime.unloadPlugin(...)`
   * produces an actually-stopped LifeOps:
   *   - Unregister task workers (proactive, follow-up, scheduler)
   *   - Delete the persisted task rows that reference those workers
   *
   * Routes, services, actions, providers, and event listeners are cleaned
   * up automatically by the runtime's plugin-lifecycle teardown — no need
   * to touch those here.
   */
  dispose: async (runtime: IAgentRuntime) => {
    const taskNames: readonly string[] = [
      PROACTIVE_TASK_NAME,
      LIFEOPS_TASK_NAME,
      FOLLOWUP_TRACKER_TASK_NAME,
    ];

    // Delete persisted Task rows so the scheduler doesn't try to run them
    // on restart (the worker function will be gone).
    for (const name of taskNames) {
      try {
        const tasks = await runtime.getTasks({
          agentIds: [runtime.agentId],
        });
        for (const task of tasks) {
          if (task.name === name && task.id) {
            try {
              await runtime.deleteTask(task.id);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              runtime.logger?.warn?.(
                `[lifeops:dispose] Failed to delete task ${name} (${task.id}): ${msg}`,
              );
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        runtime.logger?.warn?.(
          `[lifeops:dispose] Failed to list tasks for "${name}": ${msg}`,
        );
      }
    }

    // Unregister the in-memory worker functions.
    for (const name of taskNames) {
      try {
        runtime.unregisterTaskWorker?.(name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        runtime.logger?.warn?.(
          `[lifeops:dispose] Failed to unregister task worker "${name}": ${msg}`,
        );
      }
    }
  },
};

export const appLifeOpsPlugin: Plugin = rawAppLifeOpsPlugin;

export {
  getAppBlockerPermissionState,
  getAppBlockerStatus,
  getCachedAppBlockerStatus,
  getInstalledApps,
  requestAppBlockerPermission,
  selectAppsForBlocking,
  startAppBlock,
  stopAppBlock,
} from "./app-blocker/engine.js";
export type {
  OverdueDigest,
  OverdueFollowup,
} from "./followup/index.js";
export {
  computeOverdueFollowups,
  FOLLOWUP_DEFAULT_THRESHOLD_DAYS,
  FOLLOWUP_MEMORY_TABLE,
  FOLLOWUP_TRACKER_INTERVAL_MS,
  FOLLOWUP_TRACKER_TASK_NAME,
  FOLLOWUP_TRACKER_TASK_TAGS,
  getFollowupTrackerRoomId,
  listOverdueFollowupsAction,
  markFollowupDoneAction,
  reconcileFollowupsOnce,
  registerFollowupTrackerWorker,
  setFollowupThresholdAction,
  writeOverdueDigestMemory,
} from "./followup/index.js";
export { CheckinService } from "./lifeops/checkin/checkin-service.js";
export type { CheckinSchedule } from "./lifeops/checkin/schedule-resolver.js";
export { resolveCheckinSchedule } from "./lifeops/checkin/schedule-resolver.js";
export type {
  CheckinKind,
  CheckinReport,
  EscalationLevel,
  MeetingEntry,
  OverdueTodo,
  RecentWin,
  RecordAcknowledgementRequest,
  RunCheckinRequest,
} from "./lifeops/checkin/types.js";
// LifeOps runtime exports
export {
  ensureLifeOpsSchedulerTask,
  executeLifeOpsSchedulerTask,
  LIFEOPS_TASK_INTERVAL_MS,
  LIFEOPS_TASK_JITTER_MS,
  LIFEOPS_TASK_NAME,
  LIFEOPS_TASK_TAGS,
  registerLifeOpsTaskWorker,
  resolveLifeOpsTaskIntervalMs,
} from "./lifeops/runtime.js";
export { appBlockerProvider } from "./providers/app-blocker.js";
export { healthProvider } from "./providers/health.js";
export { inboxTriageProvider } from "./providers/inbox-triage.js";
export { lifeOpsProvider } from "./providers/lifeops.js";
export type { LifeOpsRouteContext } from "./routes/lifeops-routes.js";
export { handleLifeOpsRoutes } from "./routes/lifeops-routes.js";
export type { WebsiteBlockerRouteContext } from "./routes/website-blocker-routes.js";
export { handleWebsiteBlockerRoutes } from "./routes/website-blocker-routes.js";
export {
  BrowserBridgePluginService,
  browserBridgeProvider,
  manageBrowserBridgeAction,
};
