/**
 * Self-control (hosts-file website blocker) — public API for
 * `@elizaos/app-lifeops/selfcontrol` subpath imports.
 */

export {
  blockWebsitesAction,
  getWebsiteBlockStatusAction,
  requestWebsiteBlockingPermissionAction,
  selfControlBlockWebsitesAction,
  selfControlGetStatusAction,
  selfControlRequestPermissionAction,
  selfControlUnblockWebsitesAction,
  unblockWebsitesAction,
} from "./action.ts";

export { selfControlProvider, websiteBlockerProvider } from "./provider.ts";

export {
  clearWebsiteBlockerExpiryTasks,
  executeWebsiteBlockerExpiryTask,
  registerWebsiteBlockerTaskWorker,
  SelfControlBlockerService,
  syncWebsiteBlockerExpiryTask,
  WEBSITE_BLOCKER_UNBLOCK_TASK_NAME,
  WEBSITE_BLOCKER_UNBLOCK_TASK_TAGS,
  WebsiteBlockerService,
} from "./service.ts";

export {
  getSelfControlPermissionState,
  getSelfControlStatus,
  hasWebsiteBlockDeferralIntent,
  hasWebsiteBlockIntent,
  openSelfControlPermissionLocation,
  parseSelfControlBlockRequest,
  requestSelfControlPermission,
  setSelfControlPluginConfig,
  startSelfControlBlock,
  stopSelfControlBlock,
} from "./selfcontrol.ts";

export type {
  SelfControlBlockRequest,
  SelfControlElevationMethod,
  SelfControlPermissionState,
  SelfControlPluginConfig,
  SelfControlStatus,
} from "./selfcontrol.ts";

export { getSelfControlAccess, SELFCONTROL_ACCESS_ERROR } from "./access.ts";

export { checkSenderRole } from "./roles.ts";

export type { PermissionStatus } from "./permissions.ts";
