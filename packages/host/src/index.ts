/** Node HTTP host implementation and shared host contracts. */

export { drainAppRoutePluginLoaders } from "./api/drain-app-route-plugins.js";
export {
  DEFAULT_MAX_BODY_BYTES,
  isJsonObjectBody,
  readJsonBody,
  readRequestBody,
  readRequestBodyBuffer,
  sendJson,
  sendJsonError,
  writeJsonError,
  writeJsonErrorSafe,
  writeJsonResponse,
  writeJsonResponseSafe,
} from "./api/http-helpers.js";
export type { HostExecutionBaseline } from "./host-execution-env.js";
export {
  applyHostExecutionBaseline,
  applyHostToolchainExecutionBaseline,
  captureHostExecutionBaseline,
  createHostExecutionBaseline,
  getHostExecutionBaseline,
  HOST_EXECUTION_BASELINE_ENV_MIRROR_KEYS,
  isHostExecutionBaselineMirrorKey,
  isHostExecutionToolchainEnvKey,
  resolveHostExecutable,
  validateHostExecutionDirectory,
  validateHostExecutionPath,
} from "./host-execution-env.js";
export { defaultOwnerEntityId } from "./owner-entity.js";
export type {
  ProcessCrashGuardOptions,
  UncaughtExceptionPolicy,
} from "./process-guards.js";
export {
  installProcessCrashGuards,
  resetProcessCrashGuardsForTest,
} from "./process-guards.js";
export * from "./protocol.js";
export {
  DEV_MODE_ENV,
  getSelfEditDeniedSuffixes,
  isSelfEditEnabled,
  isSelfEditPathDenied,
  SELF_EDIT_ENABLE_ENV,
} from "./self-edit.js";
export type {
  ProjectRecord,
  ProjectRegistry,
} from "./utils/project-registry.js";
export {
  getActiveProject,
  getProjectById,
  PROJECT_WORLD_ID_PREFIX,
  projectRegistryPath,
  readProjectRegistry,
  setActiveProject,
  upsertProject,
  writeProjectRegistry,
} from "./utils/project-registry.js";
export type { WorkspaceFolderConfig } from "./utils/workspace-folder-config.js";
export {
  clearWorkspaceFolderConfig,
  readWorkspaceFolderConfig,
  workspaceFolderConfigPath,
  writeWorkspaceFolderConfig,
} from "./utils/workspace-folder-config.js";
