export * from "./contracts/index.ts";
export { LifeOpsService, LifeOpsServiceError } from "./lifeops/service.ts";
export * from "./platform/index.ts";
export { getAppBlockerStatus } from "./app-blocker/engine.ts";
export type {
  LifeOpsRouteContext,
  WebsiteBlockerRouteContext,
} from "./plugin.ts";
// Re-export the full plugin from plugin.ts
export {
  appLifeOpsPlugin,
  BrowserBridgePluginService,
  browserBridgeProvider,
  ensureLifeOpsSchedulerTask,
  executeLifeOpsSchedulerTask,
  handleLifeOpsRoutes,
  handleWebsiteBlockerRoutes,
  inboxTriageProvider,
  LIFEOPS_TASK_INTERVAL_MS,
  LIFEOPS_TASK_JITTER_MS,
  LIFEOPS_TASK_NAME,
  LIFEOPS_TASK_TAGS,
  lifeAction,
  lifeOpsProvider,
  manageBrowserBridgeAction,
  registerLifeOpsTaskWorker,
  resolveLifeOpsTaskIntervalMs,
  updateOwnerProfileAction,
} from "./plugin.ts";
export {
  type CloudFeaturesRouteState,
  handleCloudFeaturesRoute,
} from "./routes/cloud-features-routes.ts";
export { calendarAction } from "./actions/calendar.ts";
export { gmailAction } from "./actions/gmail.ts";
export { inboxAction } from "./actions/inbox.ts";
export { lifeopsPlugin } from "./routes/plugin.ts";
export { detectHealthBackend } from "./lifeops/health-bridge.ts";
export { detectPasswordManagerBackend } from "./lifeops/password-manager-bridge.ts";
export { detectRemoteDesktopBackend } from "./lifeops/remote-desktop.ts";
export {
  handleTravelProviderRelayRoute,
  type TravelProviderRelayRouteState,
} from "./routes/travel-provider-relay-routes.ts";
export type {
  AppBlockerSettingsCardProps,
  AppBlockerSettingsMode,
  WebsiteBlockerSettingsCardProps,
  WebsiteBlockerSettingsMode,
} from "./types/index.ts";
export type {
  NativeWebsiteBlockerBackend,
  SelfControlBlockRequest,
  SelfControlElevationMethod,
  SelfControlPermissionState,
  SelfControlPluginConfig,
  SelfControlStatus,
} from "./website-blocker/public.ts";
export {
  blockWebsitesAction,
  clearWebsiteBlockerExpiryTasks,
  executeWebsiteBlockerExpiryTask,
  getNativeWebsiteBlockerBackend,
  getSelfControlAccess,
  getSelfControlPermissionState,
  getSelfControlStatus,
  getWebsiteBlockStatusAction,
  openSelfControlPermissionLocation,
  parseSelfControlBlockRequest,
  registerNativeWebsiteBlockerBackend,
  registerWebsiteBlockerTaskWorker,
  requestSelfControlPermission,
  requestWebsiteBlockingPermissionAction,
  SELFCONTROL_ACCESS_ERROR,
  SelfControlBlockerService,
  setSelfControlPluginConfig,
  startSelfControlBlock,
  stopSelfControlBlock,
  syncWebsiteBlockerExpiryTask,
  unblockWebsitesAction,
  WEBSITE_BLOCKER_UNBLOCK_TASK_NAME,
  WEBSITE_BLOCKER_UNBLOCK_TASK_TAGS,
  WebsiteBlockerService,
  websiteBlockerProvider,
} from "./website-blocker/public.ts";
