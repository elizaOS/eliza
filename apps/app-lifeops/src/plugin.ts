import { logger, type IAgentRuntime, type Plugin } from "@elizaos/core";
import { lifeOpsSchema } from "./lifeops/schema.js";
import { LifeOpsRepository } from "./lifeops/repository.js";
import { gatePluginSessionForHostedApp } from "@elizaos/agent/services/app-session-gate";
import { manageLifeOpsBrowserAction } from "./action.ts";
import { lifeOpsBrowserProvider } from "./provider.ts";
import { LifeOpsBrowserPluginService } from "./service.ts";
import {
  blockWebsitesAction,
  getWebsiteBlockStatusAction,
  requestWebsiteBlockingPermissionAction,
  unblockWebsitesAction,
} from "./actions/website-blocker.js";
import {
  blockAppsAction,
  unblockAppsAction,
  getAppBlockStatusAction,
} from "./actions/app-blocker.js";
import { websiteBlockerProvider } from "./providers/website-blocker.js";
import { appBlockerProvider } from "./providers/app-blocker.js";
import {
  type SelfControlPluginConfig,
  getSelfControlStatus,
  setSelfControlPluginConfig,
} from "./website-blocker/engine.js";
import { WebsiteBlockerService } from "./website-blocker/service.js";

// LifeOps core actions (calendar, gmail, life/tasks, goals, inbox, owner profile)
import { calendarAction } from "./actions/calendar.js";
import { gmailAction } from "./actions/gmail.js";
import { xReadAction } from "./actions/x-read.js";
import { inboxAction } from "./actions/inbox.js";
import { lifeAction } from "./actions/life.js";
import { updateOwnerProfileAction } from "./actions/update-owner-profile.js";
// T9f — Morning/night check-in engine (plan §6.23).
import {
  runMorningCheckinAction,
  runNightCheckinAction,
} from "./actions/checkin.js";
import { relationshipAction } from "./actions/relationships.js";
import { screenTimeAction } from "./actions/screen-time.js";
import { twilioCallAction } from "./actions/twilio-call.js";
import { remoteDesktopAction } from "./actions/remote-desktop.js";
import { lifeOpsComputerUseAction } from "./actions/computer-use.js";
import { crossChannelSendAction } from "./actions/cross-channel-send.js";
import { intentSyncAction } from "./actions/intent-sync.js";
import { passwordManagerAction } from "./actions/password-manager.js";
import { calendlyAction } from "./actions/calendly.js";
import {
  checkAvailabilityAction,
  proposeMeetingTimesAction,
  schedulingAction,
  updateMeetingPreferencesAction,
} from "./actions/scheduling.js";

// LifeOps core providers
import { inboxTriageProvider } from "./providers/inbox-triage.js";
import { lifeOpsProvider } from "./providers/lifeops.js";

// LifeOps runtime (scheduler task worker + registration)
import {
  ensureLifeOpsSchedulerTask,
  registerLifeOpsTaskWorker,
} from "./lifeops/runtime.js";

// Activity-profile (proactive agent: GM/GN/nudges)
import { activityProfileProvider } from "./providers/activity-profile.js";
import {
  ensureProactiveAgentTask,
  registerProactiveTaskWorker,
} from "./activity-profile/proactive-worker.js";

// Follow-up tracker (T7c — plan §6.4)
import {
  listOverdueFollowupsAction,
  markFollowupDoneAction,
  setFollowupThresholdAction,
  registerFollowupTrackerWorker,
} from "./followup/index.js";

const rawAppLifeOpsPlugin: Plugin = {
  name: "@elizaos/app-lifeops",
  description:
    "LifeOps: routines, goals, Google Workspace, Apple Reminders, Twilio, browser companions (Chrome/Safari), website blocking, app blocking, and related surfaces.",
  schema: lifeOpsSchema,
  actions: [
    manageLifeOpsBrowserAction,
    blockWebsitesAction,
    getWebsiteBlockStatusAction,
    requestWebsiteBlockingPermissionAction,
    unblockWebsitesAction,
    blockAppsAction,
    unblockAppsAction,
    getAppBlockStatusAction,
    calendarAction,
    gmailAction,
    xReadAction,
    inboxAction,
    lifeAction,
    updateOwnerProfileAction,
    runMorningCheckinAction,
    runNightCheckinAction,
    relationshipAction,
    screenTimeAction,
    twilioCallAction,
    remoteDesktopAction,
    lifeOpsComputerUseAction,
    crossChannelSendAction,
    intentSyncAction,
    passwordManagerAction,
    calendlyAction,
    proposeMeetingTimesAction,
    checkAvailabilityAction,
    updateMeetingPreferencesAction,
    schedulingAction,
    listOverdueFollowupsAction,
    markFollowupDoneAction,
    setFollowupThresholdAction,
  ],
  providers: [
    lifeOpsBrowserProvider,
    websiteBlockerProvider,
    appBlockerProvider,
    lifeOpsProvider,
    inboxTriageProvider,
    activityProfileProvider,
  ],
  services: [LifeOpsBrowserPluginService, WebsiteBlockerService],
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
        `[lifeops] CRITICAL: Failed to bootstrap database schema — LifeOps queries will fail: ${msg}`,
      );
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
    const proactiveAgentDisabled = (() => {
      const disableValue = (
        process.env.ELIZA_DISABLE_PROACTIVE_AGENT ?? ""
      )
        .trim()
        .toLowerCase();
      if (
        disableValue === "1" ||
        disableValue === "true" ||
        disableValue === "yes"
      ) {
        return true;
      }
      const enableValue = (process.env.ENABLE_PROACTIVE_AGENT ?? "")
        .trim()
        .toLowerCase();
      return enableValue === "0" || enableValue === "false";
    })();
    if (!proactiveAgentDisabled) {
      registerProactiveTaskWorker(runtime);
    } else {
      runtime.logger?.info(
        "[proactive] Proactive agent task skipped — ELIZA_DISABLE_PROACTIVE_AGENT=1",
      );
    }
    if (!proactiveAgentDisabled) {
      void (async () => {
        const PROACTIVE_DELAYS = [2_000, 5_000, 10_000];
        for (let attempt = 0; attempt <= PROACTIVE_DELAYS.length; attempt++) {
          try {
            await ensureProactiveAgentTask(runtime);
            return;
          } catch (error) {
            const msg =
              error instanceof Error ? error.message : String(error);
            if (attempt < PROACTIVE_DELAYS.length) {
              runtime.logger?.warn?.(
                `[proactive] Task init failed (attempt ${attempt + 1}/${PROACTIVE_DELAYS.length + 1}), retrying in ${PROACTIVE_DELAYS[attempt]}ms: ${msg}`,
              );
              await new Promise((r) => setTimeout(r, PROACTIVE_DELAYS[attempt]));
            } else {
              runtime.logger?.error?.(
                `[proactive] Task init failed after ${PROACTIVE_DELAYS.length + 1} attempts — proactive agent is NOT running: ${msg}`,
              );
            }
          }
        }
      })();
    }

    // Register the follow-up tracker worker (T7c). computeOverdueFollowups
    // degrades gracefully when RelationshipsService isn't registered.
    registerFollowupTrackerWorker(runtime);

    // Register the LifeOps scheduler task worker and ensure the scheduler task exists
    registerLifeOpsTaskWorker(runtime);
    void (async () => {
      const DELAYS = [2_000, 5_000, 10_000];
      for (let attempt = 0; attempt <= DELAYS.length; attempt++) {
        try {
          await ensureLifeOpsSchedulerTask(runtime);
          return;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (attempt < DELAYS.length) {
            runtime.logger?.warn?.(
              `[lifeops] Scheduler task init failed (attempt ${attempt + 1}/${DELAYS.length + 1}), retrying in ${DELAYS[attempt]}ms: ${msg}`,
            );
            await new Promise((r) => setTimeout(r, DELAYS[attempt]));
          } else {
            runtime.logger?.error?.(
              `[lifeops] Scheduler task init failed after ${DELAYS.length + 1} attempts — LifeOps scheduler is NOT running: ${msg}`,
            );
          }
        }
      }
    })();
  },
};

export const appLifeOpsPlugin: Plugin = gatePluginSessionForHostedApp(
  rawAppLifeOpsPlugin,
  "@elizaos/app-lifeops",
);

export const lifeOpsBrowserPlugin = appLifeOpsPlugin;

export {
  LifeOpsBrowserPluginService,
  lifeOpsBrowserProvider,
  manageLifeOpsBrowserAction,
};

// LifeOps core exports
export { calendarAction } from "./actions/calendar.js";
export { gmailAction } from "./actions/gmail.js";
export { inboxAction } from "./actions/inbox.js";
export { lifeAction } from "./actions/life.js";
export { updateOwnerProfileAction } from "./actions/update-owner-profile.js";
export {
  checkAvailabilityAction,
  proposeMeetingTimesAction,
  schedulingAction,
  updateMeetingPreferencesAction,
} from "./actions/scheduling.js";
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
export { blockAppsAction, unblockAppsAction, getAppBlockStatusAction } from "./actions/app-blocker.js";
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
