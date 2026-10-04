/** Fetch, retry and wire contracts safe for Worker and Node hosts. */
export { type BoundedFetchOptions, boundedFetch } from "./bounded-fetch";

export {
  GATEWAY_TOKEN_MAX_LIFETIME_SECONDS,
  GATEWAY_TOKEN_REQUEST_TIMEOUT_MS,
  type GatewayTokenResponse,
  gatewayTokenRefreshDelayMs,
  gatewayTokenRetryDelayMs,
  parseGatewayTokenResponse,
  requestGatewayToken,
} from "./gateway-auth";

export {
  executeGatewayForwardAttempts,
  type GatewayForwardOptions,
  type GatewayPostOptions,
  type GatewayTargetResult,
  postGatewayTarget,
} from "./gateway-forward";

export {
  type ConsistentHashRing,
  createHashRouter,
  type HashRouter,
  type HashRouterOptions,
} from "./hash-router";

export {
  extractIdentityLinkCode,
  identityLinkReply,
  normalizeIdentityLinkCodeBody,
} from "./identity-link-code";
export {
  ELIZA_FAILURE_CAUSE_NAME_HEADER,
  ELIZA_FAILURE_NAME_HEADER,
  ELIZA_FAILURE_STAGE_HEADER,
  ELIZA_RETRYABLE_HEADER,
  PERSONAL_SHARED_FAILURE_REPLY,
  PERSONAL_SHARED_NO_RESPONSE_REPLY,
  type PersonalSharedFailureMetadata,
  personalSharedFailureReply,
  personalSharedNoResponseFailure,
  readPersonalSharedFailureMetadata,
} from "./personal-shared-failure";
export {
  executeResponseAttempts,
  type ResponseAttemptObservation,
  type ResponseAttemptsOptions,
  type ResponseAttemptsResult,
  type ResponseReplayPolicy,
  type ResponseRetryReason,
} from "./response-attempts";
export {
  type BackoffOptions,
  computeBackoffMs,
  parseRetryAfterMs,
  sleepWithAbort,
} from "./retry";
export { toWellFormedUnicode, truncateWellFormed } from "./text";
