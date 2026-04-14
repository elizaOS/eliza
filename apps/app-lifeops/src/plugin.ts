import { logger, type IAgentRuntime, type Plugin } from "@elizaos/core";
import { gatePluginSessionForHostedApp } from "@elizaos/agent/services/app-session-gate";
import { manageLifeOpsBrowserAction } from "./action.ts";
import { lifeOpsBrowserProvider } from "./provider.ts";
import { LifeOpsBrowserPluginService } from "./service.ts";
import {
  blockWebsitesAction,
  getWebsiteBlockStatusAction,
  requestWebsiteBlockingPermissionAction,
  unblockWebsitesAction,
} from "./selfcontrol/action.ts";
import { websiteBlockerProvider } from "./selfcontrol/provider.ts";
import {
  type SelfControlPluginConfig,
  getSelfControlStatus,
  setSelfControlPluginConfig,
} from "./selfcontrol/selfcontrol.ts";
import { WebsiteBlockerService } from "./selfcontrol/service.ts";

// LifeOps core actions (calendar, gmail, life/tasks, goals, inbox, owner profile)
import { calendarAction } from "./actions/calendar.js";
import { gmailAction } from "./actions/gmail.js";
import { inboxAction } from "./actions/inbox.js";
import { lifeAction } from "./actions/life.js";
import { updateOwnerProfileAction } from "./actions/update-owner-profile.js";

// LifeOps core providers
import { inboxTriageProvider } from "./providers/inbox-triage.js";
import { lifeOpsProvider } from "./providers/lifeops.js";

// LifeOps runtime (scheduler task worker + registration)
import {
  ensureLifeOpsSchedulerTask,
  registerLifeOpsTaskWorker,
} from "./lifeops/runtime.js";

const rawAppLifeOpsPlugin: Plugin = {
  name: "@elizaos/app-lifeops",
  description:
    "LifeOps: routines, goals, Google Workspace, Apple Reminders, Twilio, browser companions (Chrome/Safari), hosts-file website blocking, and related surfaces.",
  actions: [
    manageLifeOpsBrowserAction,
    blockWebsitesAction,
    getWebsiteBlockStatusAction,
    requestWebsiteBlockingPermissionAction,
    unblockWebsitesAction,
    calendarAction,
    gmailAction,
    inboxAction,
    lifeAction,
    updateOwnerProfileAction,
  ],
  providers: [
    lifeOpsBrowserProvider,
    websiteBlockerProvider,
    lifeOpsProvider,
    inboxTriageProvider,
  ],
  services: [LifeOpsBrowserPluginService, WebsiteBlockerService],
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
export { inboxTriageProvider } from "./providers/inbox-triage.js";
export { lifeOpsProvider } from "./providers/lifeops.js";

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

export * from "./selfcontrol/index.ts";

export default appLifeOpsPlugin;
