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
} from "../actions/website-blocker.ts";

export {
  selfControlProvider,
  websiteBlockerProvider,
} from "../providers/website-blocker.ts";

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
  openSelfControlPermissionLocation,
  parseSelfControlBlockRequest,
  registerNativeWebsiteBlockerBackend,
  getNativeWebsiteBlockerBackend,
  requestSelfControlPermission,
  setSelfControlPluginConfig,
  startSelfControlBlock,
  stopSelfControlBlock,
} from "./engine.ts";

export type {
  NativeWebsiteBlockerBackend,
  SelfControlBlockRequest,
  SelfControlElevationMethod,
  SelfControlPermissionState,
  SelfControlPluginConfig,
  SelfControlStatus,
} from "./engine.ts";

export { getSelfControlAccess, SELFCONTROL_ACCESS_ERROR } from "./access.ts";

export { checkSenderRole } from "./roles.ts";

export type { PermissionStatus } from "./permissions.ts";
