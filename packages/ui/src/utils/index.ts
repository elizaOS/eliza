/**
 * Barrel for the UI utils surface: numeric parsers, formatters, and the
 * re-exported shared helpers.
 */
export { type BrowserTabKit, type BrowserTabKitCursorPoint, type BrowserTabKitDispatchOptions, type BrowserTabKitMoveOptions, type BrowserTabKitTypeOptions } from "@elizaos/ui/utils/browser-tab-kit-types";
export { autoLabel, ENV_KEY_ACRONYMS } from "@elizaos/ui/utils/labels";
export { BROWSER_TAB_PRELOAD_SCRIPT, type BrowserTabsRendererImpl, setBrowserTabsRendererImpl } from "@elizaos/ui/utils/browser-tabs-renderer-registry";
export { clearElizaApiBase, clearElizaApiToken, type ElizaWindow, getElizaApiBase, getElizaApiToken, setElizaApiBase, setElizaApiToken } from "@elizaos/core/utils/eliza-globals";
export { computeStreamingDelta, DELTA_STREAM_PROTOCOL, type DeltaStreamProtocol, mergeStreamingText, resolveStreamingUpdate, type StreamingUpdateResult } from "@elizaos/ui/utils/streaming-text";
export { createRateLimiter, type RateLimitCheck, type RateLimiter, type RateLimiterOptions } from "@elizaos/ui/utils/rate-limiter";
export { createSerialise } from "@elizaos/core/utils/serialise";
export { type DocumentImageCompressionPlatform, type DocumentImageUploadFile, isDocumentImageFile, MAX_DOCUMENT_IMAGE_PROCESSING_BYTES, maybeCompressDocumentUploadImage } from "@elizaos/ui/utils/documents-upload-image";
export { ensureNamespaceDefaults } from "@elizaos/ui/utils/namespace-defaults";
export { ensureRuntimeSqlCompatibility, executeRawSql, quoteIdent, sanitizeIdentifier, sqlLiteral } from "@elizaos/plugin-sql/database-utils/sql-compat";
export { errorMessage, isRedirectResponse, isTimeoutError } from "@elizaos/core/utils/errors";
export { formatSubscriptionRequestError, normalizeOpenAICallbackInput } from "@elizaos/ui/utils/subscription-auth";
export { formatTrajectoryDuration, formatTrajectoryTimestamp, formatTrajectoryTokenCount } from "@elizaos/ui/utils/trajectory-format";
export { getLogPrefix } from "@elizaos/core/utils/log-prefix";
export { isCloudStatusAuthenticated, isCloudStatusReasonApiKeyOnly } from "@elizaos/ui/utils/cloud-status";
export { isSafeExecutableValue } from "@elizaos/core/utils/exec-safety";
export { modelLooksLikeElizaCloudHosted } from "@elizaos/ui/utils/eliza-cloud-model-route";
export { normalizeCharacterMessageExamples } from "@elizaos/core/utils/character-message-examples";
export { normalizeOwnerName } from "@elizaos/ui/utils/owner-name";
export { type ParseClampedIntegerOptions, type ParseClampedNumberOptions, type ParsePositiveNumberOptions, parseClampedFloat, parseClampedInteger, parsePositiveFloat, parsePositiveInteger } from "@elizaos/core/utils/number-parsing";
export { resolveApiUrl, resolveAppAssetUrl } from "@elizaos/ui/utils/asset-url";
export { stripAssistantStageDirections } from "@elizaos/core/utils/assistant-text";
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
