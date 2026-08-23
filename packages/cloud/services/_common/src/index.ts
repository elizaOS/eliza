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
  DEFAULT_K8S_WAKE_TIMEOUT_MS,
  type K8sDeploymentWakeOptions,
  patchK8sDeploymentScale,
} from "./k8s-deployment-wake";
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
  splitTelegramMessage,
  TELEGRAM_HOSTED_FILE_MAX_BYTES,
  TELEGRAM_VOICE_MAX_BYTES,
  TELEGRAM_VOICE_MAX_DURATION_SECONDS,
  TelegramApiResponseError,
  TelegramApiTransportError,
  type TelegramConnectorConfig,
  type TelegramConnectorEvent,
  type TelegramConnectorLogger,
  type TelegramDeliveryReceipt,
  type TelegramReplyDeliveryHooks,
  type TelegramResolvedVoiceNote,
  verifyTelegramWebhook,
} from "./telegram-connector";
export {
  executeTelegramDelivery,
  type TelegramDeliveryLedger,
  type TelegramDeliveryOutcome,
  TelegramDeliveryPlanConflictError,
  type TelegramDeliveryState,
  TelegramEgressAlreadyClaimedError,
} from "./telegram-delivery";
export { toWellFormedUnicode, truncateWellFormed } from "./text";
