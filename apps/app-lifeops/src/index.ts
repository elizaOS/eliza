import "./client.ts";

export type {
  AppBlockerSettingsCardProps,
  AppBlockerSettingsMode,
} from "./types/index.ts";
export type {
  WebsiteBlockerSettingsCardProps,
  WebsiteBlockerSettingsMode,
} from "./types/index.ts";

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
  proposeMeetingTimesAction,
  checkAvailabilityAction,
  updateMeetingPreferencesAction,
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

export * from "./website-blocker/public.ts";

// UI page views
export * from "./components/LifeOpsBrowserSetupPanel.tsx";
export * from "./components/LifeOpsPageView.tsx";
export * from "./components/LifeOpsPageSections.tsx";
export * from "./components/LifeOpsSettingsSection.tsx";
export * from "./components/LifeOpsWorkspaceView.tsx";
export * from "./components/WebsiteBlockerSettingsCard.tsx";
export * from "./components/AppBlockerSettingsCard.tsx";

export { appLifeOpsPlugin as default } from "./plugin.ts";
