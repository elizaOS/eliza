/**
 * Self-control (hosts-file website blocker) — public API for
 * `@elizaos/app-lifeops/selfcontrol` subpath imports.
 */

export { ownerWebsiteBlockAction } from "../actions/owner-website-block.ts";

export { websiteBlockerProvider } from "../providers/website-blocker.ts";
export { getSelfControlAccess, SELFCONTROL_ACCESS_ERROR } from "./access.ts";
export type {
  NativeWebsiteBlockerBackend,
  SelfControlBlockRequest,
  SelfControlElevationMethod,
  SelfControlPermissionState,
  SelfControlPluginConfig,
  SelfControlStatus,
} from "./engine.ts";
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
} from "./engine.ts";
export type { PermissionStatus } from "./permissions.ts";

export { checkSenderRole } from "./roles.ts";
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
