/**
 * Barrel for the UI utils surface: numeric parsers, formatters, and the
 * re-exported shared helpers.
 */

export { stripAssistantStageDirections } from "@elizaos/core/utils/assistant-text";
export { normalizeCharacterMessageExamples } from "@elizaos/core/utils/character-message-examples";
export {
  clearElizaApiBase,
  clearElizaApiToken,
  type ElizaWindow,
  getElizaApiBase,
  getElizaApiToken,
  setElizaApiBase,
  setElizaApiToken,
} from "@elizaos/core/utils/eliza-globals";
export {
  errorMessage,
  isRedirectResponse,
  isTimeoutError,
} from "@elizaos/core/utils/errors";
export { isSafeExecutableValue } from "@elizaos/core/utils/exec-safety";
export { getLogPrefix } from "@elizaos/core/utils/log-prefix";
export {
  type ParseClampedIntegerOptions,
  type ParseClampedNumberOptions,
  type ParsePositiveNumberOptions,
  parseClampedFloat,
  parseClampedInteger,
  parsePositiveFloat,
  parsePositiveInteger,
} from "@elizaos/core/utils/number-parsing";
export { createSerialise } from "@elizaos/core/utils/serialise";
export * from "../lib/floating-layers";
export { cn } from "../lib/utils";
export { resolveApiUrl, resolveAppAssetUrl } from "./asset-url.js";
export type {
  BrowserTabKit,
  BrowserTabKitCursorPoint,
  BrowserTabKitDispatchOptions,
  BrowserTabKitMoveOptions,
  BrowserTabKitTypeOptions,
} from "./browser-tab-kit-types.js";
export {
  BROWSER_TAB_PRELOAD_SCRIPT,
  type BrowserTabsRendererImpl,
  setBrowserTabsRendererImpl,
} from "./browser-tabs-renderer-registry.js";
export * from "./clipboard";
export {
  isCloudStatusAuthenticated,
  isCloudStatusReasonApiKeyOnly,
} from "./cloud-status.js";
export * from "./desktop-bug-report";
export * from "./desktop-dialogs";
export * from "./desktop-workspace";
export {
  type DocumentImageCompressionPlatform,
  type DocumentImageUploadFile,
  isDocumentImageFile,
  MAX_DOCUMENT_IMAGE_PROCESSING_BYTES,
  maybeCompressDocumentUploadImage,
} from "./documents-upload-image.js";
export { modelLooksLikeElizaCloudHosted } from "./eliza-cloud-model-route.js";
export * from "./env";
export * from "./format";
export * from "./globals";
export * from "./image-attachment";
export { autoLabel, ENV_KEY_ACRONYMS } from "./labels.js";
export * from "./name-tokens";
export { ensureNamespaceDefaults } from "./namespace-defaults.js";
export * from "./navigation-url";
export * from "./openExternalUrl";
export { normalizeOwnerName } from "./owner-name.js";
export {
  createRateLimiter,
  type RateLimitCheck,
  type RateLimiter,
  type RateLimiterOptions,
} from "./rate-limiter.js";
export {
  computeStreamingDelta,
  DELTA_STREAM_PROTOCOL,
  type DeltaStreamProtocol,
  mergeStreamingText,
  resolveStreamingUpdate,
  type StreamingUpdateResult,
} from "./streaming-text.js";
export {
  formatSubscriptionRequestError,
  normalizeOpenAICallbackInput,
} from "./subscription-auth.js";
export {
  formatTrajectoryDuration,
  formatTrajectoryTimestamp,
  formatTrajectoryTokenCount,
} from "./trajectory-format.js";
export * from "./transient-fetch";
export * from "./tts-debug";
