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
} from "./action.js";

export { selfControlProvider, websiteBlockerProvider } from "./provider.js";

export {
  clearWebsiteBlockerExpiryTasks,
  executeWebsiteBlockerExpiryTask,
  registerWebsiteBlockerTaskWorker,
  SelfControlBlockerService,
  syncWebsiteBlockerExpiryTask,
  WEBSITE_BLOCKER_UNBLOCK_TASK_NAME,
  WEBSITE_BLOCKER_UNBLOCK_TASK_TAGS,
  WebsiteBlockerService,
} from "./service.js";

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
} from "./selfcontrol.js";

export type {
  SelfControlBlockRequest,
  SelfControlElevationMethod,
  SelfControlPermissionState,
  SelfControlPluginConfig,
  SelfControlStatus,
} from "./selfcontrol.js";

export { getSelfControlAccess, SELFCONTROL_ACCESS_ERROR } from "./access.js";

export { checkSenderRole } from "./roles.js";

export type { PermissionStatus } from "./permissions.js";
