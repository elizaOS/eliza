import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { manageLifeOpsBrowserAction } from "./action.ts";
import {
  blockAppsAction,
  getAppBlockStatusAction,
  unblockAppsAction,
} from "./actions/app-blocker.js";
import { calendarAction } from "./actions/calendar.js";
import { gmailAction } from "./actions/gmail.js";
import { inboxAction } from "./actions/inbox.js";
import {
  blockWebsitesAction,
  getWebsiteBlockStatusAction,
  requestWebsiteBlockingPermissionAction,
  unblockWebsitesAction,
} from "./actions/website-blocker.js";
import {
  getSelfControlStatus,
  type SelfControlPluginConfig,
  setSelfControlPluginConfig,
} from "./website-blocker/engine.js";
import { WebsiteBlockerService } from "./website-blocker/service.js";
import {
  approveRequestAction,
  rejectRequestAction,
} from "./actions/approval.js";
import {
  addAutofillWhitelistAction,
  listAutofillWhitelistAction,
  requestFieldFillAction,
} from "./actions/autofill.js";
import { bookTravelAction } from "./actions/book-travel.js";
import { chatThreadControlAction } from "./actions/chat-thread-control.js";
import {
  runMorningCheckinAction,
  runNightCheckinAction,
} from "./actions/checkin.js";
import { lifeOpsComputerUseAction } from "./actions/computer-use.js";
import { crossChannelSendAction } from "./actions/cross-channel-send.js";
import { crossPlatformGatewayAction } from "./actions/cross-platform-gateway.js";
import { publishDeviceIntentAction } from "./actions/device-bus.js";
import { dossierAction } from "./actions/dossier.js";
import { emailUnsubscribeAction } from "./actions/email-unsubscribe.js";
import { toggleLifeOpsFeatureAction } from "./actions/feature-toggle.js";
import { healthAction } from "./actions/health.js";
import { intentSyncAction } from "./actions/intent-sync.js";
import { lifeAction } from "./actions/life.js";
import { ownerAppBlockAction } from "./actions/owner-app-block.js";
import { ownerCalendarAction } from "./actions/owner-calendar.js";
import { ownerInboxAction } from "./actions/owner-inbox.js";
import { ownerRemoteDesktopAction } from "./actions/owner-remote-desktop.js";
import { ownerScheduleAction } from "./actions/owner-schedule.js";
import { ownerScreenTimeAction } from "./actions/owner-screen-time.js";
import { ownerWebsiteBlockAction } from "./actions/owner-website-block.js";
import { passwordManagerAction } from "./actions/password-manager.js";
import { relationshipAction } from "./actions/relationships.js";
import { scheduleXDmReplyAction } from "./actions/schedule-x-dm-reply.js";
import { subscriptionsAction } from "./actions/subscriptions.js";
import {
  callExternalAction,
  callUserAction,
  twilioCallAction,
} from "./actions/twilio-call.js";
import { updateOwnerProfileAction } from "./actions/update-owner-profile.js";
import { xReadAction } from "./actions/x-read.js";
import { ActivityTrackerService } from "./activity-profile/activity-tracker-service.js";
import {
  ensureProactiveAgentTask,
  PROACTIVE_TASK_NAME,
  registerProactiveTaskWorker,
} from "./activity-profile/proactive-worker.js";
// LifeOps runtime (scheduler task worker + registration)
import {
  ensureLifeOpsSchedulerTask,
  LIFEOPS_TASK_NAME,
  registerLifeOpsTaskWorker,
} from "./lifeops/runtime.js";
import { lifeOpsSchema } from "./lifeops/schema.js";
import { lifeOpsBrowserProvider } from "./provider.ts";
// Activity-profile (proactive agent: GM/GN/nudges)
import { activityProfileProvider } from "./providers/activity-profile.js";
import { appBlockerProvider } from "./providers/app-blocker.js";
import { crossChannelContextProvider } from "./providers/cross-channel-context.js";

// LifeOps core providers
import { inboxTriageProvider } from "./providers/inbox-triage.js";
import { lifeOpsProvider } from "./providers/lifeops.js";
import { websiteBlockerProvider } from "./providers/website-blocker.js";
import { LifeOpsBrowserPluginService } from "./service.ts";
import {
  blockUntilTaskCompleteAction,
  listActiveBlocksAction,
  registerBlockRuleReconcilerWorker,
  releaseBlockAction,
} from "./website-blocker/chat-integration/index.js";

import { screenTimeAction } from "./actions/screen-time.js";
import {
  getActivityReportAction,
  getTimeOnAppAction,
  getTimeOnSiteAction,
} from "./actions/activity-report.js";

import { remoteDesktopAction } from "./actions/remote-desktop.js";
import { revokeRemoteSessionAction } from "./actions/revoke-remote-session.js";
import { listRemoteSessionsAction } from "./actions/list-remote-sessions.js";

import { searchAcrossChannelsAction } from "./actions/search-across-channels.js";

import { calendlyAction } from "./actions/calendly.js";
import {
  checkAvailabilityAction,
  proposeMeetingTimesAction,
  schedulingAction,
  updateMeetingPreferencesAction,
} from "./actions/scheduling.js";

import { generateDossierAction } from "./dossier/action.js";
import { computeTravelBufferAction } from "./travel-time/action.js";

import {
  fetchBrowserActivityAction,
  registerBrowserSessionAction,
} from "./actions/browser-extension.js";

import {
  FOLLOWUP_TRACKER_TASK_NAME,
  listOverdueFollowupsAction,
  markFollowupDoneAction,
  setFollowupThresholdAction,
  registerFollowupTrackerWorker,
} from "./followup/index.js";

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
 *
 * Prior docs in REMEDIATION_LOG.md item #8 stated that this path should
 * "abort init after bounded retries" — that claim is NOT currently enforced
 * because aborting here would orphan an already-loaded plugin. Do not read
 * REMEDIATION_LOG #8 as a live contract; read this comment instead.
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
    manageLifeOpsBrowserAction,
    ownerWebsiteBlockAction,
    blockWebsitesAction,
    getWebsiteBlockStatusAction,
    requestWebsiteBlockingPermissionAction,
    unblockWebsitesAction,
    blockUntilTaskCompleteAction,
    listActiveBlocksAction,
    releaseBlockAction,
    ownerAppBlockAction,
    blockAppsAction,
    unblockAppsAction,
    getAppBlockStatusAction,
    ownerCalendarAction,
    calendarAction,
    gmailAction,
    ownerInboxAction,
    xReadAction,
    scheduleXDmReplyAction,
    inboxAction,
    approveRequestAction,
    rejectRequestAction,
    lifeAction,
    bookTravelAction,
    updateOwnerProfileAction,
    runMorningCheckinAction,
    runNightCheckinAction,
    relationshipAction,
    ownerScreenTimeAction,
    screenTimeAction,
    getActivityReportAction,
    getTimeOnAppAction,
    getTimeOnSiteAction,
    twilioCallAction,
    callUserAction,
    callExternalAction,
    ownerRemoteDesktopAction,
    remoteDesktopAction,
    revokeRemoteSessionAction,
    listRemoteSessionsAction,
    lifeOpsComputerUseAction,
    ownerScheduleAction,
    crossChannelSendAction,
    searchAcrossChannelsAction,
    publishDeviceIntentAction,
    intentSyncAction,
    passwordManagerAction,
    requestFieldFillAction,
    addAutofillWhitelistAction,
    listAutofillWhitelistAction,
    calendlyAction,
    proposeMeetingTimesAction,
    checkAvailabilityAction,
    updateMeetingPreferencesAction,
    schedulingAction,
    listOverdueFollowupsAction,
    markFollowupDoneAction,
    setFollowupThresholdAction,
    dossierAction,
    generateDossierAction,
    computeTravelBufferAction,
    healthAction,
    subscriptionsAction,
    emailUnsubscribeAction,
    chatThreadControlAction,
    registerBrowserSessionAction,
    fetchBrowserActivityAction,
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

// T9f — Morning/night check-in engine (plan §6.23).
export {
  runMorningCheckinAction,
  runNightCheckinAction,
} from "./actions/checkin.js";
export { lifeAction } from "./actions/life.js";
// App blocker exports
export { ownerAppBlockAction } from "./actions/owner-app-block.js";
// LifeOps core exports
export { ownerCalendarAction } from "./actions/owner-calendar.js";
export { ownerInboxAction } from "./actions/owner-inbox.js";
export { ownerScheduleAction } from "./actions/owner-schedule.js";
export { updateOwnerProfileAction } from "./actions/update-owner-profile.js";
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
// Follow-up tracker (T7c)
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
export { inboxTriageProvider } from "./providers/inbox-triage.js";
export { lifeOpsProvider } from "./providers/lifeops.js";
export type { LifeOpsRouteContext } from "./routes/lifeops-routes.js";
// Routes (consumed by agent server.ts via import)
export { handleLifeOpsRoutes } from "./routes/lifeops-routes.js";
export type { WebsiteBlockerRouteContext } from "./routes/website-blocker-routes.js";
export { handleWebsiteBlockerRoutes } from "./routes/website-blocker-routes.js";
export * from "./website-blocker/public.ts";
export {
  LifeOpsBrowserPluginService,
  lifeOpsBrowserProvider,
  manageLifeOpsBrowserAction,
};

export default appLifeOpsPlugin;
