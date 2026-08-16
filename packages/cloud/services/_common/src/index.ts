// Shares index service primitives across cloud worker sidecars.

export {
  GATEWAY_TOKEN_MAX_LIFETIME_SECONDS,
  GATEWAY_TOKEN_REQUEST_TIMEOUT_MS,
  type GatewayTokenResponse,
  gatewayTokenRefreshDelayMs,
  gatewayTokenRetryDelayMs,
  parseGatewayTokenResponse,
} from "./gateway-auth";
export {
  extractIdentityLinkCode,
  identityLinkReply,
} from "./identity-link-code";
export {
  __resetServiceAccountCacheForTests,
  readServiceAccountCaCert,
  readServiceAccountToken,
} from "./k8s-service-account";
export {
  createServiceLogger,
  type ServiceLogger,
  type ServiceLoggerOptions,
} from "./logger";
export {
  executeResponseAttempts,
  type ResponseAttemptObservation,
  type ResponseAttemptsOptions,
  type ResponseAttemptsResult,
  type ResponseRetryReason,
} from "./response-attempts";
export { parseTelegramBotId } from "./telegram-account";
export {
  parseTelegramWebhook,
  prepareTelegramReply,
  resolveTelegramVoiceNote,
  sendTelegramReply,
  sendTelegramReplyChunk,
  sendTelegramTyping,
  TELEGRAM_HOSTED_FILE_MAX_BYTES,
  TELEGRAM_VOICE_MAX_BYTES,
  TELEGRAM_VOICE_MAX_DURATION_SECONDS,
  TelegramApiResponseError,
  type TelegramConnectorConfig,
  type TelegramConnectorEvent,
  type TelegramConnectorLogger,
  type TelegramDeliveryReceipt,
  type TelegramResolvedVoiceNote,
  TelegramUnknownAcceptanceError,
  verifyTelegramWebhook,
} from "./telegram-connector";
export {
  executeTelegramDelivery,
  type TelegramDeliveryLedger,
  type TelegramDeliveryOutcome,
  type TelegramDeliveryPlan,
  type TelegramDeliveryProgress,
  type TelegramProviderSendOutcome,
} from "./telegram-delivery";
