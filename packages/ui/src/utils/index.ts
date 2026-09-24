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
} from "@elizaos/shared";
export {
  autoLabel,
  BROWSER_TAB_PRELOAD_SCRIPT,
  type BrowserTabsRendererImpl,
  clearElizaApiBase,
  clearElizaApiToken,
  computeStreamingDelta,
  createRateLimiter,
  createSerialise,
  DELTA_STREAM_PROTOCOL,
  type DeltaStreamProtocol,
  type DocumentImageCompressionPlatform,
  type DocumentImageUploadFile,
  type ElizaWindow,
  ENV_KEY_ACRONYMS,
  ensureNamespaceDefaults,
  ensureRuntimeSqlCompatibility,
  errorMessage,
  executeRawSql,
  formatSubscriptionRequestError,
  formatTrajectoryDuration,
  formatTrajectoryTimestamp,
  formatTrajectoryTokenCount,
  getElizaApiBase,
  getElizaApiToken,
  getLogPrefix,
  isCloudStatusAuthenticated,
  isCloudStatusReasonApiKeyOnly,
  isDocumentImageFile,
  isRedirectResponse,
  isSafeExecutableValue,
  isTimeoutError,
  MAX_DOCUMENT_IMAGE_PROCESSING_BYTES,
  maybeCompressDocumentUploadImage,
  mergeStreamingText,
  modelLooksLikeElizaCloudHosted,
  normalizeCharacterMessageExamples,
  normalizeOpenAICallbackInput,
  normalizeOwnerName,
  type ParseClampedIntegerOptions,
  type ParseClampedNumberOptions,
  type ParsePositiveNumberOptions,
  parseClampedFloat,
  parseClampedInteger,
  parsePositiveFloat,
  parsePositiveInteger,
  quoteIdent,
  type RateLimitCheck,
  type RateLimiter,
  type RateLimiterOptions,
  resolveApiUrl,
  resolveAppAssetUrl,
  resolveStreamingUpdate,
  type StreamingUpdateResult,
  sanitizeIdentifier,
  setBrowserTabsRendererImpl,
  setElizaApiBase,
  setElizaApiToken,
  sqlLiteral,
  stripAssistantStageDirections,
} from "@elizaos/shared";
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
