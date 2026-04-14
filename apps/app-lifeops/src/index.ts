// Re-export the full plugin from plugin.ts
export {
  appLifeOpsPlugin,
  lifeOpsBrowserPlugin,
  LifeOpsBrowserPluginService,
  lifeOpsBrowserProvider,
  manageLifeOpsBrowserAction,
  calendarAction,
  gmailAction,
  inboxAction,
  lifeAction,
  lifeOpsProvider,
  updateOwnerProfileAction,
  inboxTriageProvider,
  handleLifeOpsRoutes,
  handleWebsiteBlockerRoutes,
  ensureLifeOpsSchedulerTask,
  registerLifeOpsTaskWorker,
  executeLifeOpsSchedulerTask,
  resolveLifeOpsTaskIntervalMs,
  LIFEOPS_TASK_NAME,
  LIFEOPS_TASK_TAGS,
  LIFEOPS_TASK_INTERVAL_MS,
  LIFEOPS_TASK_JITTER_MS,
} from "./plugin.ts";
export type { LifeOpsRouteContext } from "./plugin.ts";
export type { WebsiteBlockerRouteContext } from "./plugin.ts";

export { lifeopsPlugin } from "./routes/plugin.ts";

export * from "./selfcontrol/index.ts";

// UI page views
export * from "./LifeOpsBrowserSetupPanel.tsx";
export * from "./LifeOpsPageView.tsx";
export * from "./LifeOpsPageSections.tsx";
export * from "./LifeOpsSettingsSection.tsx";
export * from "./LifeOpsWorkspaceView.tsx";
export * from "./WebsiteBlockerSettingsCard.tsx";

export { appLifeOpsPlugin as default } from "./plugin.ts";
