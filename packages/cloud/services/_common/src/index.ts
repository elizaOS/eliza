// Shares index service primitives across cloud worker sidecars.

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
export {
  parseTelegramWebhook,
  resolveTelegramVoiceNote,
  sendTelegramReply,
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
  verifyTelegramWebhook,
} from "./telegram-connector";
export {
  executeTelegramDelivery,
  type TelegramDeliveryLedger,
  type TelegramDeliveryOutcome,
  type TelegramDeliveryState,
  TelegramEgressAlreadyClaimedError,
} from "./telegram-delivery";
