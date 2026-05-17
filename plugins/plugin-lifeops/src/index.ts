export { detectHealthBackend } from "@elizaos/plugin-health";
// External consumers that still import `websiteBlockAction` get the canonical
// BLOCK umbrella.
export {
  blockAction,
  blockAction as websiteBlockAction,
} from "./actions/block.js";
export { calendarAction } from "./actions/calendar.js";
export { connectorAction } from "./actions/connector.js";
export { credentialsAction } from "./actions/credentials.js";
export { entityAction } from "./actions/entity.js";
export { calendlyAction } from "./actions/lib/calendly-handler.js";
export {
  ownerAlarmsAction,
  ownerFinancesAction,
  ownerGoalsAction,
  ownerHealthAction,
  ownerRemindersAction,
  ownerRoutinesAction,
  ownerScreenTimeAction,
  ownerTodosAction,
  personalAssistantAction,
} from "./actions/owner-surfaces.js";
export { remoteDesktopAction } from "./actions/remote-desktop.js";
export { resolveRequestAction } from "./actions/resolve-request.js";
export { voiceCallAction } from "./actions/voice-call.js";
export * from "./api/client-lifeops.js";
export { getAppBlockerStatus } from "./app-blocker/engine.js";
export * from "./client.js";
export * from "./inbox/types.js";
export {
  type ApprovalQueueOptions,
  createApprovalQueue,
  PgApprovalQueue,
} from "./lifeops/approval-queue.js";
export * from "./lifeops/index.js";
export * from "./lifeops/messaging/index.js";
export { detectPasswordManagerBackend } from "./lifeops/password-manager-bridge.js";
export { detectRemoteDesktopBackend } from "./lifeops/remote-desktop.js";
export { LifeOpsRepository } from "./lifeops/repository.js";
export { LifeOpsService, LifeOpsServiceError } from "./lifeops/service.js";
export * from "./platform/index.js";
export type {
  LifeOpsRouteContext,
  WebsiteBlockerRouteContext,
} from "./plugin.js";
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
  lifeOpsProvider,
  registerLifeOpsTaskWorker,
  resolveLifeOpsTaskIntervalMs,
} from "./plugin.js";
export * from "./public.js";
export {
  type CloudFeaturesRouteState,
  handleCloudFeaturesRoute,
} from "./routes/cloud-features-routes.js";
export { lifeopsPlugin } from "./routes/plugin.js";
export {
  handleTravelProviderRelayRoute,
  type TravelProviderRelayRouteState,
} from "./routes/travel-provider-relay-routes.js";
export * from "./types/app-blocker-settings-card.js";
export type {
  AppBlockerSettingsCardProps,
  AppBlockerSettingsMode,
  WebsiteBlockerSettingsCardProps,
  WebsiteBlockerSettingsMode,
} from "./types/index.js";
export * from "./types/index.js";
export * from "./types/website-blocker-settings-card.js";
export * from "./ui.js";
export * from "./website-blocker/engine.js";
export type {
  NativeWebsiteBlockerBackend,
  SelfControlBlockRequest,
  SelfControlElevationMethod,
  SelfControlPermissionState,
  SelfControlPluginConfig,
  SelfControlStatus,
} from "./website-blocker/public.js";
export {
  clearWebsiteBlockerExpiryTasks,
  executeWebsiteBlockerExpiryTask,
  getNativeWebsiteBlockerBackend,
  getSelfControlAccess,
  getSelfControlPermissionState,
  getSelfControlStatus,
  openSelfControlPermissionLocation,
  parseSelfControlBlockRequest,
  registerNativeWebsiteBlockerBackend,
  registerWebsiteBlockerTaskWorker,
  requestSelfControlPermission,
  SELFCONTROL_ACCESS_ERROR,
  SelfControlBlockerService,
  setSelfControlPluginConfig,
  startSelfControlBlock,
  stopSelfControlBlock,
  syncWebsiteBlockerExpiryTask,
  WEBSITE_BLOCKER_UNBLOCK_TASK_NAME,
  WEBSITE_BLOCKER_UNBLOCK_TASK_TAGS,
  WebsiteBlockerService,
  websiteBlockerProvider,
} from "./website-blocker/public.js";
export * from "./widgets/index.js";
