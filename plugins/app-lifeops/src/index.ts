// Surviving owner-* action exports.

export { ownerDeviceIntentAction } from "./actions/owner-device-intent.ts";
export { ownerAppBlockAction } from "./actions/owner-app-block.ts";
export { ownerAutofillAction } from "./actions/owner-autofill.ts";
export { bookTravelAction } from "./actions/owner-book-travel.ts";
export { ownerCalendarAction } from "./actions/owner-calendar.ts";
export { chatThreadControlAction } from "./actions/owner-chat-thread.ts";
export { ownerCheckinAction } from "./actions/owner-checkin.ts";
export { lifeOpsComputerUseAction } from "./actions/owner-computer-use.ts";
export { lifeOpsConnectorAction } from "./actions/owner-connector.ts";
export { healthAction } from "./actions/owner-health.ts";
export { lifeAction } from "./actions/owner-life.ts";
export { passwordManagerAction } from "./actions/owner-password-manager.ts";
export { paymentsAction } from "./actions/owner-payments.ts";
export { ownerProfileAction } from "./actions/owner-profile.ts";
export { relationshipAction } from "./actions/owner-relationship.ts";
export { ownerRemoteDesktopAction } from "./actions/owner-remote-desktop.ts";
export { ownerResolveRequestAction } from "./actions/owner-resolve-request.ts";
export { ownerScheduleAction } from "./actions/owner-schedule.ts";
export { ownerScreenTimeAction } from "./actions/owner-screen-time.ts";
export { subscriptionsAction } from "./actions/owner-subscriptions.ts";
export { toggleLifeOpsFeatureAction } from "./actions/owner-toggle-feature.ts";
export { ownerVoiceCallAction } from "./actions/owner-voice-call.ts";
export { ownerWebsiteBlockAction } from "./actions/owner-website-block.ts";
export { xReadAction } from "./actions/owner-x.ts";
export { getAppBlockerStatus } from "./app-blocker/engine.ts";
export * from "./contracts/index.ts";
export { detectHealthBackend } from "./lifeops/health-bridge.ts";
// Messaging surface — owner send policy + first-party adapters.
export * from "./lifeops/messaging/index.ts";
export { detectPasswordManagerBackend } from "./lifeops/password-manager-bridge.ts";
export { detectRemoteDesktopBackend } from "./lifeops/remote-desktop.ts";
export { LifeOpsService, LifeOpsServiceError } from "./lifeops/service.ts";
export * from "./platform/index.ts";
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
  lifeOpsProvider,
  manageBrowserBridgeAction,
  registerLifeOpsTaskWorker,
  resolveLifeOpsTaskIntervalMs,
} from "./plugin.ts";
export {
  type CloudFeaturesRouteState,
  handleCloudFeaturesRoute,
} from "./routes/cloud-features-routes.ts";
export { lifeopsPlugin } from "./routes/plugin.ts";
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
} from "./website-blocker/public.ts";
