/**
 * Self-control (hosts-file website blocker) — public API for
 * `@elizaos/app-lifeops/selfcontrol` subpath imports.
 */

export { websiteBlockAction } from "../actions/website-block.js";

export { websiteBlockerProvider } from "../providers/website-blocker.js";
export { getSelfControlAccess, SELFCONTROL_ACCESS_ERROR } from "./access.js";
export type {
  NativeWebsiteBlockerBackend,
  SelfControlBlockRequest,
  SelfControlElevationMethod,
  SelfControlPermissionState,
  SelfControlPluginConfig,
  SelfControlStatus,
} from "./engine.js";
export {
  getNativeWebsiteBlockerBackend,
  getSelfControlPermissionState,
  getSelfControlStatus,
  openSelfControlPermissionLocation,
  parseSelfControlBlockRequest,
  registerNativeWebsiteBlockerBackend,
  requestSelfControlPermission,
  setSelfControlPluginConfig,
  startSelfControlBlock,
  stopSelfControlBlock,
} from "./engine.js";
export type { PermissionStatus } from "./permissions.js";

export { checkSenderRole } from "./roles.js";
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
