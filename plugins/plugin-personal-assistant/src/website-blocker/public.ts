/**
 * Self-control (hosts-file website blocker) — public API for
 * `@elizaos/plugin-personal-assistant/selfcontrol` subpath imports.
 *
 * The website-blocker platform now lives in `@elizaos/plugin-blocker`. This
 * barrel re-exports the moved symbols so existing subpath consumers keep
 * working. The BLOCK umbrella action still lives in this package.
 */

export { websiteBlockerProvider } from "@elizaos/plugin-blocker/providers/website-blocker";

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
  type PermissionStatus,
  parseSelfControlBlockRequest,
  registerNativeWebsiteBlockerBackend,
  registerWebsiteBlockerTaskWorker,
  requestSelfControlPermission,
  SELFCONTROL_ACCESS_ERROR,
  SelfControlBlockerService,
  type SelfControlBlockRequest,
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
} from "@elizaos/plugin-blocker/services/website-blocker/index";
// External consumers that still import `websiteBlockAction` get the canonical
// BLOCK umbrella (mirrors `src/index.ts`).
export { blockAction as websiteBlockAction } from "../actions/block.js";
