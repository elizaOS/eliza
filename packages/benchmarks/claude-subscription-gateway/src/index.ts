/** Public construction and contract surface for the loopback benchmark gateway. */

export {
  type AuditSink,
  DurableAuditStore,
  InMemoryAuditStore,
  toAuditArtifact,
} from "./audit.js";
export {
  canonicalizeChatCompletion,
  GatewayRequestError,
  normalizedToolChoiceLabel,
  parseChatCompletionRequest,
  stableJson,
} from "./canonical.js";
export {
  assertNoApiBillingEnvironment,
  buildClaudeCodeManagedEnvironment,
  CLAUDE_AGENT_SDK_VERSION,
  type ClaudeAgentSdkModule,
  ClaudeCompletionError,
  ClaudeCredentialPolicyError,
  ClaudeRateLimitError,
  ClaudeSdkCompletionRunner,
  type ClaudeSdkCompletionRunnerOptions,
  FORBIDDEN_API_BILLING_ENV_NAMES,
  normalizeResetTimestampMs,
} from "./claude-completion.js";
export {
  type CredentialBrokerLease,
  type CredentialLeaseBroker,
  CredentialParityError,
  RotatingCredentialCompletionRunner,
  type RotatingCredentialCompletionRunnerOptions,
} from "./credential-rotation.js";
export {
  buildGatewayContentAttestation,
  gatewayContentAttestationViolation,
  parseGatewayContentContract,
} from "./content-attestation.js";
export {
  FairHarnessQueue,
  type FairHarnessQueueOptions,
  QueueCapacityError,
  type QueuedResult,
} from "./fair-queue.js";
export {
  GatewayStorageError,
  type ClaudeSubscriptionGatewayHandle,
  type GatewayHarnessEnvironment,
  type GatewayLogger,
  type GatewayStorageGuard,
  type StartClaudeSubscriptionGatewayOptions,
  startClaudeSubscriptionGateway,
} from "./server.js";
export {
  HashChainCorruptionError,
  type HashChainedJsonlCursor,
  HashChainedJsonl,
  type HashChainedJsonlOptions,
} from "./hash-chained-jsonl.js";
export {
  computeLogicalKeySha256,
  type LogicalRequest,
  LogicalRequestAllocator,
  makeLogicalRequest,
} from "./logical-request.js";
export {
  type ReplayCompletion,
  ReplayJournal,
  ReplayMismatchError,
} from "./replay-journal.js";
export type {
  CanonicalChatCompletion,
  CapturedToolCall,
  ChatRole,
  ClaudeCompletionResult,
  CompletionContext,
  CompletionFinishReason,
  CompletionRunner,
  CompletionUsage,
  GatewayAuditRecord,
  GatewayContentAttestation,
  GatewayContentContract,
  GatewayProvenance,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  NormalizedChatCompletionRequest,
  NormalizedChatMessage,
  NormalizedFunctionTool,
  NormalizedToolCall,
  NormalizedToolChoice,
} from "./types.js";
