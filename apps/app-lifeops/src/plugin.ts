import { logger, type IAgentRuntime, type Plugin } from "@elizaos/core";
import { lifeOpsSchema } from "./lifeops/schema.js";
import { LifeOpsRepository } from "./lifeops/repository.js";
import { manageLifeOpsBrowserAction } from "./action.ts";
import { lifeOpsBrowserProvider } from "./provider.ts";
import { LifeOpsBrowserPluginService } from "./service.ts";
import { ownerWebsiteBlockAction } from "./actions/owner-website-block.js";
import { ownerAppBlockAction } from "./actions/owner-app-block.js";
import { websiteBlockerProvider } from "./providers/website-blocker.js";
import { appBlockerProvider } from "./providers/app-blocker.js";
import {
  type SelfControlPluginConfig,
  getSelfControlStatus,
  setSelfControlPluginConfig,
} from "./website-blocker/engine.js";
import { WebsiteBlockerService } from "./website-blocker/service.js";
// T7g — Website blocker chat integration (plan §6.8).
import {
  blockUntilTaskCompleteAction,
  listActiveBlocksAction,
  registerBlockRuleReconcilerWorker,
  releaseBlockAction,
} from "./website-blocker/chat-integration/index.js";

// LifeOps core actions (calendar, gmail, life/tasks, goals, inbox, owner profile)
import { ownerCalendarAction } from "./actions/owner-calendar.js";
import { ownerInboxAction } from "./actions/owner-inbox.js";
import { ownerScheduleAction } from "./actions/owner-schedule.js";
import { xReadAction } from "./actions/x-read.js";
import { lifeAction } from "./actions/life.js";
import { updateOwnerProfileAction } from "./actions/update-owner-profile.js";
// T9f — Morning/night check-in engine (plan §6.23).
import {
  runMorningCheckinAction,
  runNightCheckinAction,
} from "./actions/checkin.js";
import { relationshipAction } from "./actions/relationships.js";
import { ownerScreenTimeAction } from "./actions/owner-screen-time.js";
import { ActivityTrackerService } from "./activity-profile/activity-tracker-service.js";
import {
  callExternalAction,
  callUserAction,
  twilioCallAction,
} from "./actions/twilio-call.js";
import { ownerRemoteDesktopAction } from "./actions/owner-remote-desktop.js";
import { lifeOpsComputerUseAction } from "./actions/computer-use.js";
import { crossChannelSendAction } from "./actions/cross-channel-send.js";
import { intentSyncAction } from "./actions/intent-sync.js";
import { publishDeviceIntentAction } from "./actions/device-bus.js";
import { passwordManagerAction } from "./actions/password-manager.js";
import {
  addAutofillWhitelistAction,
  listAutofillWhitelistAction,
  requestFieldFillAction,
} from "./actions/autofill.js";
import { dossierAction } from "./actions/dossier.js";
import { bookTravelAction } from "./actions/book-travel.js";
// T7f — meeting dossier (plan §6.7).
import { generateDossierAction } from "./dossier/action.js";
// T8a — travel-time awareness (plan §6.9).
import { computeTravelBufferAction } from "./travel-time/action.js";
import { healthAction } from "./actions/health.js";
import { subscriptionsAction } from "./actions/subscriptions.js";
import { emailUnsubscribeAction } from "./actions/email-unsubscribe.js";
// T8e — browser extension bridge actions (plan §6.13).
import {
  fetchBrowserActivityAction,
  registerBrowserSessionAction,
} from "./actions/browser-extension.js";
import {
  approveRequestAction,
  rejectRequestAction,
} from "./actions/approval.js";

// LifeOps core providers
import { inboxTriageProvider } from "./providers/inbox-triage.js";
import { lifeOpsProvider } from "./providers/lifeops.js";
import { crossChannelContextProvider } from "./providers/cross-channel-context.js";

// LifeOps runtime (scheduler task worker + registration)
import {
  ensureLifeOpsSchedulerTask,
  LIFEOPS_TASK_NAME,
  registerLifeOpsTaskWorker,
} from "./lifeops/runtime.js";

// Activity-profile (proactive agent: GM/GN/nudges)
import { activityProfileProvider } from "./providers/activity-profile.js";
import {
  ensureProactiveAgentTask,
  PROACTIVE_TASK_NAME,
  registerProactiveTaskWorker,
} from "./activity-profile/proactive-worker.js";

// Follow-up tracker (T7c — plan §6.4)
import {
  FOLLOWUP_TRACKER_TASK_NAME,
  registerFollowupTrackerWorker,
} from "./followup/index.js";

async function ensureTaskWithRetries(args: {
  runtime: IAgentRuntime;
  prefix: string;
  label: string;
  ensure: () => Promise<unknown>;
  delays?: readonly number[];
}): Promise<void> {
  const delays = args.delays ?? [2_000, 5_000, 10_000];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await args.ensure();
      return;
    } catch (error) {
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

function scheduleTaskEnsureAfterRuntimeInit(args: {
  runtime: IAgentRuntime;
  prefix: string;
  label: string;
  ensure: () => Promise<unknown>;
  delays?: readonly number[];
}): void {
  void args.runtime.initPromise
    .then(async () => {
      await ensureTaskWithRetries(args);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      args.runtime.logger?.error?.(
        `${args.prefix} ${args.label} init failed after runtime initialization: ${message}`,
      );
    });
}

const rawAppLifeOpsPlugin: Plugin = {
  name: "@elizaos/app-lifeops",
  description:
    "LifeOps: routines, goals, Google Workspace, Apple Reminders, Twilio, browser companions (Chrome/Safari), website blocking, app blocking, and related surfaces.",
  schema: lifeOpsSchema,
  actions: [
    manageLifeOpsBrowserAction,
    ownerWebsiteBlockAction,
    blockUntilTaskCompleteAction,
    listActiveBlocksAction,
    releaseBlockAction,
    ownerAppBlockAction,
    ownerCalendarAction,
    ownerInboxAction,
    ownerScheduleAction,
    xReadAction,
    lifeAction,
    updateOwnerProfileAction,
    runMorningCheckinAction,
    runNightCheckinAction,
    relationshipAction,
    ownerScreenTimeAction,
    twilioCallAction,
    callUserAction,
    callExternalAction,
    ownerRemoteDesktopAction,
    lifeOpsComputerUseAction,
    crossChannelSendAction,
    bookTravelAction,
    intentSyncAction,
    approveRequestAction,
    rejectRequestAction,
    passwordManagerAction,
    requestFieldFillAction,
    addAutofillWhitelistAction,
    listAutofillWhitelistAction,
    dossierAction,
    healthAction,
    subscriptionsAction,
    emailUnsubscribeAction,
  ],
  providers: [
    lifeOpsBrowserProvider,
    websiteBlockerProvider,
    appBlockerProvider,
    lifeOpsProvider,
    inboxTriageProvider,
    crossChannelContextProvider,
    activityProfileProvider,
  ],
  services: [
    LifeOpsBrowserPluginService,
    WebsiteBlockerService,
    ActivityTrackerService,
  ],
  init: async (
    pluginConfig: Record<string, unknown>,
    runtime: IAgentRuntime,
  ) => {
    // Bootstrap LifeOps database tables before anything else runs.
    try {
      await LifeOpsRepository.bootstrapSchema(runtime);
      logger.info("[lifeops] Database schema bootstrapped");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[lifeops] Failed to bootstrap database schema: ${msg}`,
      );
      throw error instanceof Error ? error : new Error(msg);
    }

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

    // Register the proactive agent (activity-profile: GM/GN/nudges)
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

    // Register the follow-up tracker worker (T7c). computeOverdueFollowups
    // degrades gracefully when RelationshipsService isn't registered.
    registerFollowupTrackerWorker(runtime);

    // T7g — Register the website blocker chat integration reconciler.
    registerBlockRuleReconcilerWorker(runtime);

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

export const lifeOpsBrowserPlugin = appLifeOpsPlugin;

export {
  LifeOpsBrowserPluginService,
  lifeOpsBrowserProvider,
  manageLifeOpsBrowserAction,
};

// LifeOps core exports
export { ownerCalendarAction } from "./actions/owner-calendar.js";
export { ownerInboxAction } from "./actions/owner-inbox.js";
export { ownerScheduleAction } from "./actions/owner-schedule.js";
export { lifeAction } from "./actions/life.js";
export { updateOwnerProfileAction } from "./actions/update-owner-profile.js";
export { inboxTriageProvider } from "./providers/inbox-triage.js";
export { lifeOpsProvider } from "./providers/lifeops.js";

// T9f — Morning/night check-in engine (plan §6.23).
export {
  runMorningCheckinAction,
  runNightCheckinAction,
} from "./actions/checkin.js";
export { CheckinService } from "./lifeops/checkin/checkin-service.js";
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
export { resolveCheckinSchedule } from "./lifeops/checkin/schedule-resolver.js";
export type { CheckinSchedule } from "./lifeops/checkin/schedule-resolver.js";

// Routes (consumed by agent server.ts via import)
export { handleLifeOpsRoutes } from "./routes/lifeops-routes.js";
export type { LifeOpsRouteContext } from "./routes/lifeops-routes.js";
export { handleWebsiteBlockerRoutes } from "./routes/website-blocker-routes.js";
export type { WebsiteBlockerRouteContext } from "./routes/website-blocker-routes.js";

// LifeOps runtime exports
export {
  ensureLifeOpsSchedulerTask,
  registerLifeOpsTaskWorker,
  executeLifeOpsSchedulerTask,
  resolveLifeOpsTaskIntervalMs,
  LIFEOPS_TASK_NAME,
  LIFEOPS_TASK_TAGS,
  LIFEOPS_TASK_INTERVAL_MS,
  LIFEOPS_TASK_JITTER_MS,
} from "./lifeops/runtime.js";

export * from "./website-blocker/public.ts";

// App blocker exports
export { ownerAppBlockAction } from "./actions/owner-app-block.js";
export { appBlockerProvider } from "./providers/app-blocker.js";
export {
  getAppBlockerStatus,
  getCachedAppBlockerStatus,
  getAppBlockerPermissionState,
  requestAppBlockerPermission,
  getInstalledApps,
  selectAppsForBlocking,
  startAppBlock,
  stopAppBlock,
} from "./app-blocker/engine.js";

// Follow-up tracker (T7c)
export {
  listOverdueFollowupsAction,
  markFollowupDoneAction,
  setFollowupThresholdAction,
  registerFollowupTrackerWorker,
  reconcileFollowupsOnce,
  computeOverdueFollowups,
  writeOverdueDigestMemory,
  getFollowupTrackerRoomId,
  FOLLOWUP_TRACKER_TASK_NAME,
  FOLLOWUP_TRACKER_TASK_TAGS,
  FOLLOWUP_TRACKER_INTERVAL_MS,
  FOLLOWUP_DEFAULT_THRESHOLD_DAYS,
  FOLLOWUP_MEMORY_TABLE,
} from "./followup/index.js";
export type {
  OverdueDigest,
  OverdueFollowup,
} from "./followup/index.js";

export default appLifeOpsPlugin;
