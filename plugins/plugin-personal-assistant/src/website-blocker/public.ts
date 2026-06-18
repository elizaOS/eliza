/**
 * Self-control (hosts-file website blocker) — public API for
 * `@elizaos/plugin-personal-assistant/selfcontrol` subpath imports.
 *
 * The website-blocker platform now lives in `@elizaos/plugin-blocker`. This
 * barrel re-exports the moved symbols so existing subpath consumers keep
 * working. The BLOCK umbrella action still lives in this package.
 */

// External consumers that still import `websiteBlockAction` get the canonical
// BLOCK umbrella (mirrors `src/index.ts`).
export { blockAction as websiteBlockAction } from "../actions/block.js";

export {
  checkSenderRole,
  clearWebsiteBlockerExpiryTasks,
  executeWebsiteBlockerExpiryTask,
  getNativeWebsiteBlockerBackend,
  getSelfControlAccess,
  getSelfControlPermissionState,
  getSelfControlStatus,
  type NativeWebsiteBlockerBackend,
  openSelfControlPermissionLocation,
  parseSelfControlBlockRequest,
  type PermissionStatus,
  registerNativeWebsiteBlockerBackend,
  registerWebsiteBlockerTaskWorker,
  requestSelfControlPermission,
  SELFCONTROL_ACCESS_ERROR,
  type SelfControlBlockRequest,
  SelfControlBlockerService,
  type SelfControlElevationMethod,
  type SelfControlPermissionState,
  type SelfControlPluginConfig,
  type SelfControlStatus,
  setSelfControlPluginConfig,
  startSelfControlBlock,
  stopSelfControlBlock,
  syncWebsiteBlockerExpiryTask,
  WEBSITE_BLOCKER_UNBLOCK_TASK_NAME,
  WEBSITE_BLOCKER_UNBLOCK_TASK_TAGS,
  WebsiteBlockerService,
  websiteBlockerProvider,
} from "@elizaos/plugin-blocker";
