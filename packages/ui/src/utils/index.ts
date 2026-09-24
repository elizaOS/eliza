/**
 * Barrel for the UI utils surface: numeric parsers, formatters, and the
 * re-exported shared helpers.
 */

export type {
  BrowserTabKit,
  BrowserTabKitCursorPoint,
  BrowserTabKitDispatchOptions,
  BrowserTabKitMoveOptions,
  BrowserTabKitTypeOptions,
  BrowserTabsRendererImpl,
  DeltaStreamProtocol,
  DocumentImageCompressionPlatform,
  DocumentImageUploadFile,
  ElizaWindow,
  ParseClampedIntegerOptions,
  ParseClampedNumberOptions,
  ParsePositiveNumberOptions,
  RateLimitCheck,
  RateLimiter,
  RateLimiterOptions,
  StreamingUpdateResult,
} from "@elizaos/shared";
export {
  resolveApiUrl,
  resolveAppAssetUrl,
} from "@elizaos/shared/utils/asset-url";
export { stripAssistantStageDirections } from "@elizaos/shared/utils/assistant-text";
export {
  BROWSER_TAB_PRELOAD_SCRIPT,
  setBrowserTabsRendererImpl,
} from "@elizaos/shared/utils/browser-tabs-renderer-registry";
export { normalizeCharacterMessageExamples } from "@elizaos/shared/utils/character-message-examples";
export {
  isCloudStatusAuthenticated,
  isCloudStatusReasonApiKeyOnly,
} from "@elizaos/shared/utils/cloud-status";
export {
  isDocumentImageFile,
  MAX_DOCUMENT_IMAGE_PROCESSING_BYTES,
  maybeCompressDocumentUploadImage,
} from "@elizaos/shared/utils/documents-upload-image";
export { modelLooksLikeElizaCloudHosted } from "@elizaos/shared/utils/eliza-cloud-model-route";
export {
  clearElizaApiBase,
  clearElizaApiToken,
  getElizaApiBase,
  getElizaApiToken,
  setElizaApiBase,
  setElizaApiToken,
} from "@elizaos/shared/utils/eliza-globals";
export {
  errorMessage,
  isRedirectResponse,
  isTimeoutError,
} from "@elizaos/shared/utils/errors";
export { isSafeExecutableValue } from "@elizaos/shared/utils/exec-safety";
export { autoLabel, ENV_KEY_ACRONYMS } from "@elizaos/shared/utils/labels";
export { getLogPrefix } from "@elizaos/shared/utils/log-prefix";
export { ensureNamespaceDefaults } from "@elizaos/shared/utils/namespace-defaults";
export {
  parseClampedFloat,
  parseClampedInteger,
  parsePositiveFloat,
  parsePositiveInteger,
} from "@elizaos/shared/utils/number-parsing";
export { normalizeOwnerName } from "@elizaos/shared/utils/owner-name";
export { createRateLimiter } from "@elizaos/shared/utils/rate-limiter";
export { createSerialise } from "@elizaos/shared/utils/serialise";
export {
  ensureRuntimeSqlCompatibility,
  executeRawSql,
  quoteIdent,
  sanitizeIdentifier,
  sqlLiteral,
} from "@elizaos/shared/utils/sql-compat";
export {
  computeStreamingDelta,
  DELTA_STREAM_PROTOCOL,
  mergeStreamingText,
  resolveStreamingUpdate,
} from "@elizaos/shared/utils/streaming-text";
export {
  formatSubscriptionRequestError,
  normalizeOpenAICallbackInput,
} from "@elizaos/shared/utils/subscription-auth";
export {
  formatTrajectoryDuration,
  formatTrajectoryTimestamp,
  formatTrajectoryTokenCount,
} from "@elizaos/shared/utils/trajectory-format";
export * from "../lib/floating-layers";
export { cn } from "../lib/utils";
export * from "./clipboard";
export * from "./desktop-bug-report";
export * from "./desktop-dialogs";
export * from "./desktop-workspace";
export * from "./env";
export * from "./format";
export * from "./globals";
export * from "./image-attachment";
export * from "./name-tokens";
export * from "./navigation-url";
export * from "./openExternalUrl";
export * from "./transient-fetch";
export * from "./tts-debug";
