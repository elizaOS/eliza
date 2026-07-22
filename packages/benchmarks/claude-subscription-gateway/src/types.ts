/**
 * Wire and internal contracts for the Claude subscription benchmark boundary.
 * Raw HTTP values become these types only after canonical.ts validates them.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface NormalizedToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface NormalizedChatMessage {
  role: ChatRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: NormalizedToolCall[];
}

export interface NormalizedFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonObject;
  };
}

export type NormalizedToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface NormalizedChatCompletionRequest {
  model: string;
  messages: NormalizedChatMessage[];
  tools: NormalizedFunctionTool[];
  toolChoice: NormalizedToolChoice;
  parallelToolCalls: boolean;
  stream: boolean;
  streamOptionsIncludeUsage: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  metadata: JsonObject;
}

export interface CanonicalChatCompletion {
  request: NormalizedChatCompletionRequest;
  prompt: string;
  systemPrompt: string;
  promptSha256: string;
  systemPromptSha256: string;
  toolSchemaSha256: string;
  toolSchemaSha256ByName: Record<string, string>;
  requestSha256: string;
  serializerVersion: "openai-full-history-v1";
  unappliedParameters: string[];
}

export interface GatewayContentContract {
  schemaVersion: 1;
  contractId: string;
  systemHint: string;
  publicUserTurns: string[];
  forbiddenTextByCategory: Record<string, string[]>;
  observedTextByCategory: Record<string, string[]>;
  contractSha256: string;
}

export interface GatewayContentAttestation {
  schemaVersion: 1;
  contractId: string;
  contractSha256: string;
  systemHintSha256: string;
  systemHintInstructionOccurrences: number;
  systemHintUserOccurrences: number;
  systemHintGeneratedOccurrences: number;
  publicUserMatches: Record<string, number>;
  publicUserInstructionMatches: Record<string, number>;
  publicUserGeneratedMatches: Record<string, number>;
  forbiddenIngressMatchCounts: Record<string, number>;
  forbiddenIngressMatchTotal: number;
  forbiddenGeneratedMatchCounts: Record<string, number>;
  forbiddenGeneratedMatchTotal: number;
  observedInstructionMatchCounts: Record<string, number>;
  observedUserMatchCounts: Record<string, number>;
  observedIngressMatchCounts: Record<string, number>;
  observedGeneratedMatchCounts: Record<string, number>;
  messageContentManifest: Array<{
    index: number;
    role: ChatRole;
    sha256: string;
  }>;
}

export interface CapturedToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ClaudeCompletionResult {
  text: string;
  toolCalls: CapturedToolCall[];
  model: string;
  claudeCodeVersion: string | null;
  sdkApiKeySource: "none";
  resultSubtype: string;
  terminalReason: string | null;
  subscriptionType?: string;
  credentialEpochHmacSha256?: string;
  credentialTierHmacSha256?: string;
  credentialCapabilityHmacSha256?: string;
  usage: CompletionUsage;
}

export interface CompletionContext {
  requestId: string;
  harness: string;
  canonical: CanonicalChatCompletion;
  credentialOAuthToken?: string;
  credentialTierValidator?: (subscriptionType: string) => void;
}

export interface CompletionRunner {
  complete(context: CompletionContext): Promise<ClaudeCompletionResult>;
}

export type CompletionFinishReason = "stop" | "tool_calls";

export interface GatewayProvenance {
  request_id: string;
  harness: string;
  transport: "claude-agent-sdk";
  credential_source: "claude-code-managed";
  sdk_version: "0.3.200";
  sdk_api_key_source: "none";
  claude_code_version: string | null;
  fresh_session: true;
  tool_execution: "capture-only";
  serializer: "openai-full-history-v1";
  queue_wait_ms: number;
  prompt_sha256: string;
  system_prompt_sha256: string;
  tool_schema_sha256: string;
  request_sha256: string;
  parallel_tool_calls: boolean;
  unapplied_parameters: string[];
  result_subtype: string;
  terminal_reason: string | null;
  logical_namespace_sha256?: string;
  logical_ordinal?: number;
  logical_key_sha256?: string;
  execution_origin?: "original" | "replay";
}

export interface GatewayAuditRecord {
  requestId: string;
  recordedAt: string;
  harness: string;
  transport: "claude-agent-sdk";
  credentialSource: "claude-code-managed";
  sdkVersion: "0.3.200";
  sdkApiKeySource: "none";
  freshSession: true;
  toolExecution: "capture-only";
  serializer: "openai-full-history-v1";
  responseMode: "json" | "sse";
  modelRequested: string;
  modelEffective: string | null;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | null;
  claudeCodeVersion: string | null;
  messageCount: number;
  messageRoles: ChatRole[];
  toolNames: string[];
  toolChoice: string;
  parallelToolCalls: boolean;
  toolCallNames: string[];
  promptSha256: string;
  systemPromptSha256: string;
  toolSchemaSha256: string;
  toolSchemaSha256ByName: Record<string, string>;
  requestSha256: string;
  contentAttestation: GatewayContentAttestation | null;
  queueWaitMs: number;
  serviceMs: number;
  status: "succeeded" | "failed" | "paused";
  finishReason: CompletionFinishReason | null;
  resultSubtype: string | null;
  terminalReason: string | null;
  unappliedParameters: string[];
  errorCode: string | null;
  logicalNamespaceSha256?: string;
  logicalOrdinal?: number;
  logicalKeySha256?: string;
  deliveryAttempt?: number;
  executionOrigin?: "original" | "replay";
  auditEvent?:
    | "logical_completion"
    | "replay_delivery"
    | "failure"
    | "pause_control";
  credentialEpochHmacSha256?: string | null;
  credentialTierHmacSha256?: string | null;
  credentialCapabilityHmacSha256?: string | null;
  retryAt?: string | null;
  pauseReason?:
    | "rate_limit"
    | "rate_limit_unknown"
    | "storage_reserve"
    | null;
}
