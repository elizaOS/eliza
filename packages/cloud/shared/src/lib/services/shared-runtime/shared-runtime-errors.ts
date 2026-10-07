/**
 * Dependency-free error types shared by the shared-runtime chat core, its
 * conversation coordinator, and the Durable Object transport. Kept
 * import-light deliberately: the coordinator and route boundaries need real
 * class identity for these errors without dragging the billing/runtime module
 * graph into their own graphs (several catch sites additionally match on
 * `error.name` because the class cannot survive the Durable Object fetch
 * boundary).
 */
import { ElizaError } from "@elizaos/core";
import { ElizaError as RuntimeElizaError } from "@elizaos/core/errors";

export class SharedRuntimeCacheWarmingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedRuntimeCacheWarmingError";
  }
}

/**
 * A `clientMessageId` was reused with a different payload (#18045). The prior
 * turn's transcript pair must never be silently replaced, so the submission is
 * rejected rather than executed. Non-retryable by contract: the caller must
 * pick a new id for new content.
 */
export class SharedTurnConflictError extends Error {
  constructor(message = "clientMessageId was already used with a different message.") {
    super(message);
    this.name = "SharedTurnConflictError";
  }
}

export type SharedRuntimeTurnFailureName =
  | "SharedRuntimeActionContractError"
  | "SharedRuntimeNoReplyError"
  | "SharedRuntimeProviderConfigurationError"
  | "SharedRuntimeProviderRejectedError"
  | "SharedRuntimeProviderUnavailableError"
  | "SharedRuntimeTimeoutError"
  | "SharedRuntimeUnknownError";

const SHARED_RUNTIME_TURN_FAILURE_NAMES = new Set<SharedRuntimeTurnFailureName>([
  "SharedRuntimeActionContractError",
  "SharedRuntimeNoReplyError",
  "SharedRuntimeProviderConfigurationError",
  "SharedRuntimeProviderRejectedError",
  "SharedRuntimeProviderUnavailableError",
  "SharedRuntimeTimeoutError",
  "SharedRuntimeUnknownError",
]);

const SHARED_RUNTIME_TURN_RETRY_DISPOSITION: Record<SharedRuntimeTurnFailureName, boolean> = {
  SharedRuntimeActionContractError: false,
  SharedRuntimeNoReplyError: false,
  SharedRuntimeProviderConfigurationError: false,
  SharedRuntimeProviderRejectedError: false,
  SharedRuntimeProviderUnavailableError: true,
  SharedRuntimeTimeoutError: true,
  SharedRuntimeUnknownError: false,
};

export interface SharedRuntimeTurnFailureClassification {
  failureName: SharedRuntimeTurnFailureName;
  retryable: boolean;
  /** Numeric upstream status only; provider messages and payloads stay private. */
  providerStatus?: number;
}

/** Validate the only failure names allowed to cross the coordinator boundary. */
export function parseSharedRuntimeTurnFailureName(
  value: unknown,
): SharedRuntimeTurnFailureName | null {
  return typeof value === "string" &&
    SHARED_RUNTIME_TURN_FAILURE_NAMES.has(value as SharedRuntimeTurnFailureName)
    ? (value as SharedRuntimeTurnFailureName)
    : null;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0 && chain.length < 12) {
    const current = pending.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    chain.push(current);
    if ((typeof current === "object" && current !== null) || typeof current === "function") {
      const candidate = current as {
        cause?: unknown;
        lastError?: unknown;
      };
      if (candidate.lastError !== undefined) pending.push(candidate.lastError);
      if (candidate.cause !== undefined) pending.push(candidate.cause);
    }
  }
  return chain;
}

function boundedProviderStatus(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 100 || value > 599) {
    return null;
  }
  return value;
}

export function classifySharedRuntimeTurnFailure(
  error: unknown,
): SharedRuntimeTurnFailureClassification {
  const chain = errorChain(error);
  for (const current of chain) {
    if (!(current instanceof Error)) continue;
    if (
      /^Eliza Shared runtime completed an executable [A-Z_]+ request without an action result$/u.test(
        current.message,
      )
    ) {
      return {
        failureName: "SharedRuntimeActionContractError",
        retryable: false,
      };
    }
    if (current.message === "Eliza Shared runtime completed without a user-visible reply") {
      return {
        failureName: "SharedRuntimeNoReplyError",
        retryable: false,
      };
    }
  }
  for (const current of chain) {
    // The message pipeline normalizes a delivered failure to a terminal
    // outcome. The Shared adapter brands that outcome before throwing;
    // preserve its disposition instead of losing it because the original SDK
    // Error no longer survives on the normalized cause.
    if (current instanceof RuntimeElizaError && current.code === "SHARED_RUNTIME_MESSAGE_FAILED") {
      const kind = current.context?.failureKind;
      const transient = current.context?.transient;
      if (transient === true && (kind === "transient_failure" || kind === "rate_limited")) {
        return {
          failureName: "SharedRuntimeProviderUnavailableError",
          retryable: true,
        };
      }
      if (transient === false && kind === "no_provider") {
        return {
          failureName: "SharedRuntimeProviderConfigurationError",
          retryable: false,
        };
      }
      if (transient === false && (kind === "provider_issue" || kind === "insufficient_credits")) {
        return {
          failureName: "SharedRuntimeProviderRejectedError",
          retryable: false,
        };
      }
    }
    const record =
      (typeof current === "object" && current !== null) || typeof current === "function"
        ? (current as { name?: unknown; statusCode?: unknown })
        : null;
    if (!record) continue;
    const name = typeof record.name === "string" ? record.name : "";
    if (name === "ProviderConfigurationError") {
      return {
        failureName: "SharedRuntimeProviderConfigurationError",
        retryable: false,
      };
    }
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        failureName: "SharedRuntimeTimeoutError",
        retryable: true,
      };
    }
    if (name === "RateLimitError") {
      return {
        failureName: "SharedRuntimeProviderUnavailableError",
        retryable: true,
      };
    }
    const status = boundedProviderStatus(record.statusCode);
    if (status !== null) {
      return status === 408 || status === 425 || status === 429 || status >= 500
        ? {
            failureName: "SharedRuntimeProviderUnavailableError",
            retryable: true,
            providerStatus: status,
          }
        : {
            failureName: "SharedRuntimeProviderRejectedError",
            retryable: false,
            providerStatus: status,
          };
    }
  }
  return {
    failureName: "SharedRuntimeUnknownError",
    retryable: false,
  };
}

/**
 * Preserve the qualified authorization/transient HTTP failures at core's
 * boundary without letting its provider-detail extractor see SDK payloads.
 * Other provider classes retain their existing behavior until qualified.
 */
export function projectQualifiedSharedProviderFailure(
  error: unknown,
): (RuntimeElizaError & { readonly statusCode: 401 | 503 }) | undefined {
  const { providerStatus } = classifySharedRuntimeTurnFailure(error);
  if (providerStatus !== 401 && providerStatus !== 503) return undefined;
  return Object.assign(
    new RuntimeElizaError(
      providerStatus === 503
        ? "Shared model provider temporarily unavailable (HTTP 503)."
        : "Shared model provider rejected the request (HTTP 401).",
      {
        code: "SHARED_RUNTIME_PROVIDER_CALL_FAILED",
        context: { providerStatus },
        severity: providerStatus === 503 ? "ephemeral" : "fatal",
      },
    ),
    { statusCode: providerStatus } as const,
  );
}

export interface SharedModelCompletionDiagnostic {
  operation: "generate" | "stream";
  textPresent: boolean;
  toolCount: number | null;
  /** SDK count only: its zero can mean an absent provider detail, never proof of disabled reasoning. */
  sdkReasoningTokens?: number | null;
  /** This adapter does not read or retain raw response bodies to attest provider-detail presence. */
  providerReasoningDetailPresent?: boolean | null;
  finishClass: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other" | "unknown";
}

/** Project completion shape only; provider output and tool contents stay private. */
export function sharedModelCompletionDiagnostic(
  operation: "generate" | "stream",
  text: unknown,
  toolCount: number,
  finishReason: unknown,
  sdkUsage?: unknown,
): SharedModelCompletionDiagnostic {
  const finishClasses = new Set([
    "stop",
    "length",
    "content-filter",
    "tool-calls",
    "error",
    "other",
    "unknown",
  ]);
  const reasoningTokens = diagnosticProperty(sdkUsage, "reasoningTokens");
  return {
    operation,
    ...(sdkUsage !== undefined
      ? {
          sdkReasoningTokens:
            typeof reasoningTokens === "number" &&
            Number.isSafeInteger(reasoningTokens) &&
            reasoningTokens >= 0 &&
            reasoningTokens <= 4_000_000
              ? reasoningTokens
              : null,
          providerReasoningDetailPresent: null,
        }
      : {}),
    textPresent: typeof text === "string" && text.trim().length > 0,
    toolCount: Number.isSafeInteger(toolCount) && toolCount >= 0 ? Math.min(toolCount, 64) : null,
    finishClass:
      typeof finishReason === "string" && finishClasses.has(finishReason)
        ? (finishReason as SharedModelCompletionDiagnostic["finishClass"])
        : "unknown",
  };
}

export interface SharedModelFailureDiagnostic extends SharedRuntimeTurnFailureClassification {
  operation: "resolve" | "generate" | "stream";
  diagnosticSchemaVersion?: 2;
  errorName: string;
  diagnosticCode?: string;
  providerError?: SharedProviderErrorDiagnostic;
}

export interface SharedRuntimeFailureDiagnostic {
  diagnosticSchemaVersion?: 2;
  modelInvocationStarted: boolean;
  processingSuccess?: boolean | null;
  didRespond?: boolean | null;
  responseErrorPresent?: boolean | null;
  failureKind: string;
  terminalFailurePresent: boolean;
  terminalMode: "simple" | "actions" | "blocked" | "none" | "unknown";
  lastModelCompletion: SharedModelCompletionDiagnostic | null;
  modelFailure?: SharedModelFailureDiagnostic;
}

const MODEL_FAILURE_NAMES = new Set([
  "Error",
  "TypeError",
  "ElizaError",
  "ProviderConfigurationError",
  "AbortError",
  "TimeoutError",
  "AI_APICallError",
  "AI_RetryError",
  "AI_TypeValidationError",
  "AI_NoSuchToolError",
  "AI_InvalidToolInputError",
  "AI_InvalidPromptError",
  "AI_InvalidResponseDataError",
  "AI_NoOutputGeneratedError",
  "AI_NoObjectGeneratedError",
  "NoObjectGeneratedError",
  "AI_UnsupportedFunctionalityError",
  "AI_UnsupportedModelVersionError",
]);
const MODEL_FAILURE_CODES = new Set([
  "MODEL_OUTPUT_INCOMPLETE",
  "PROVIDER_FALLBACK_REFUSED",
  "OPENROUTER_FALLBACK_UNAVAILABLE",
]);
const RUNTIME_FAILURE_KINDS = new Set([
  "transient_failure",
  "rate_limited",
  "provider_issue",
  "insufficient_credits",
  "no_provider",
  "missing_capability",
  "handler_error",
  "persistence_error",
  "planner_exhaustion",
  "context_overflow",
]);
const TERMINAL_MODES = new Set(["simple", "actions", "blocked", "none", "unknown"]);
const MODEL_OPERATIONS = new Set(["resolve", "generate", "stream"]);
const COMPLETION_CLASSES = new Set([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
  "unknown",
]);

const PROVIDER_ERROR_CATEGORIES = new Set([
  "schema",
  "tool_generation",
  "tool_message_pairing",
  "duplicate_tool_call_id",
  "tool_choice",
  "context_limit",
  "unsupported_parameter",
  "invalid_request",
  "unknown",
]);
const PROVIDER_ERROR_TYPES = new Set([
  "invalid_request_error",
  "invalid_request",
  "validation_error",
  "bad_request",
  "unknown",
]);
const PROVIDER_ERROR_CODES = new Set([
  "invalid_request_error",
  "invalid_tool_schema",
  "invalid_tool_choice",
  "tool_use_failed",
  "failed_generation",
  "context_length_exceeded",
  "unsupported_parameter",
  "invalid_parameter",
  "unknown",
]);
const PROVIDER_ERROR_PARAMETERS = new Set([
  "tools",
  "messages",
  "tool_choice",
  "response_format",
  "model",
  "generation",
  "unknown",
]);

export interface SharedProviderErrorDiagnostic {
  category: string;
  type: string;
  code: string;
  parameterClass: string;
  source?: string;
  shape?: string;
  dataState?: string;
  responseBodyState?: string;
}

const DIAGNOSTIC_ACCESSOR_MISS = Symbol("diagnostic-accessor-miss");
const PROVIDER_ERROR_SOURCES = new Set(["data", "response_body", "sdk_message", "none"]);
const PROVIDER_ERROR_SHAPES = new Set([
  "standard_error",
  "error_string",
  "detail_string",
  "validation_array",
  "top_message",
  "other_json",
  "string_value",
  "plain_text",
  "sdk_message",
  "none",
]);
const PROVIDER_DATA_STATES = new Set(["absent", "object", "string", "other", "unreadable"]);
const PROVIDER_BODY_STATES = new Set([
  "absent",
  "empty",
  "oversized",
  "non_json",
  "json",
  "other",
  "unreadable",
]);

function diagnosticProperty(value: unknown, key: string): unknown {
  try {
    return value !== null && (typeof value === "object" || typeof value === "function")
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    // error-policy:J7 hostile SDK metadata is a field miss, never a new failure.
    return DIAGNOSTIC_ACCESSOR_MISS;
  }
}

function providerParameterClass(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) return "unknown";
  for (const root of ["tools", "messages", "tool_choice", "response_format", "model"]) {
    if (value === root || value.startsWith(`${root}.`) || value.startsWith(`${root}[`)) return root;
  }
  return /^(max_tokens|max_completion_tokens|temperature|top_p|seed|stream)$/.test(value)
    ? "generation"
    : "unknown";
}

function providerErrorFields(
  detail: unknown,
  messageOverride?: unknown,
): SharedProviderErrorDiagnostic {
  const rawType = diagnosticProperty(detail, "type");
  const rawCode = diagnosticProperty(detail, "code");
  const rawMessage = messageOverride ?? diagnosticProperty(detail, "message");
  const type =
    typeof rawType === "string" && PROVIDER_ERROR_TYPES.has(rawType) ? rawType : "unknown";
  const code =
    typeof rawCode === "string" && PROVIDER_ERROR_CODES.has(rawCode) ? rawCode : "unknown";
  let parameterClass = providerParameterClass(diagnosticProperty(detail, "param"));
  const loc = diagnosticProperty(detail, "loc");
  if (parameterClass === "unknown" && Array.isArray(loc)) {
    const length = diagnosticProperty(loc, "length");
    const count =
      typeof length === "number" && Number.isSafeInteger(length) && length >= 0
        ? Math.min(length, 8)
        : 0;
    for (let index = 0; index < count; index++) {
      const part = diagnosticProperty(loc, String(index));
      const candidate = providerParameterClass(part);
      if (candidate !== "unknown") {
        parameterClass = candidate;
        break;
      }
    }
  }
  const message = typeof rawMessage === "string" && rawMessage.length <= 4096 ? rawMessage : "";
  let category = "unknown";
  if (
    code === "tool_use_failed" ||
    code === "failed_generation" ||
    /failed to (generate|parse) (a )?tool.?call/i.test(message)
  )
    category = "tool_generation";
  else if (
    /duplicate.{0,80}tool.?call.{0,30}id|tool.?call.{0,30}id.{0,80}(duplicate|unique)/i.test(
      message,
    )
  )
    category = "duplicate_tool_call_id";
  else if (
    /orphan.{0,50}tool|tool.{0,60}(immediately following|corresponding tool|missing.{0,20}response|must follow|must be followed)|tool_call_id.{0,80}(not found|prior assistant|matching|response)/i.test(
      message,
    )
  )
    category = "tool_message_pairing";
  else if (
    code === "invalid_tool_choice" ||
    /tool_choice.{0,100}(tools|invalid|unsupported|required)|tools.{0,100}tool_choice/i.test(
      message,
    )
  )
    category = "tool_choice";
  else if (
    code === "invalid_tool_schema" ||
    /additionalProperties|minLength|maxLength|invalid.{0,30}schema|schema.{0,30}(unsupported|invalid)|pattern.{0,50}(supported|allowed)/i.test(
      message,
    )
  )
    category = "schema";
  else if (
    code === "context_length_exceeded" ||
    /context.{0,30}(length|window).{0,50}(exceed|limit|maximum)/i.test(message)
  )
    category = "context_limit";
  else if (
    code === "unsupported_parameter" ||
    /unsupported.{0,30}parameter|parameter.{0,30}(not supported|not allowed)/i.test(message)
  )
    category = "unsupported_parameter";
  else if (type !== "unknown" || code === "invalid_request_error" || code === "invalid_parameter")
    category = "invalid_request";
  return { category, type, code, parameterClass };
}

function providerEnvelope(value: unknown): {
  fields: SharedProviderErrorDiagnostic;
  shape: string;
} {
  if (typeof value === "string")
    return { fields: providerErrorFields(undefined, value), shape: "string_value" };
  if (value === null || typeof value !== "object")
    return { fields: providerErrorFields(undefined), shape: "other_json" };
  const error = diagnosticProperty(value, "error");
  if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    return { fields: providerErrorFields(error), shape: "standard_error" };
  }
  if (typeof error === "string")
    return { fields: providerErrorFields(value, error), shape: "error_string" };
  const detail = diagnosticProperty(value, "detail");
  if (typeof detail === "string")
    return { fields: providerErrorFields(value, detail), shape: "detail_string" };
  const validation = Array.isArray(detail) ? detail : Array.isArray(value) ? value : undefined;
  if (validation) {
    let fields = providerErrorFields(undefined);
    const length = diagnosticProperty(validation, "length");
    const count =
      typeof length === "number" && Number.isSafeInteger(length) && length >= 0
        ? Math.min(length, 8)
        : 0;
    for (let index = 0; index < count; index++) {
      const item = diagnosticProperty(validation, String(index));
      const candidate = providerErrorFields(item, diagnosticProperty(item, "msg"));
      if (candidate.category !== "unknown") {
        fields = candidate;
        break;
      }
      if (fields.parameterClass === "unknown" && candidate.parameterClass !== "unknown")
        fields = candidate;
    }
    return { fields, shape: "validation_array" };
  }
  if (typeof diagnosticProperty(value, "message") === "string") {
    return { fields: providerErrorFields(value), shape: "top_message" };
  }
  return { fields: providerErrorFields(value), shape: "other_json" };
}

/** Every matched SDK error emits shape states; bounded payload inspection stays in RAM. */
function providerErrorDiagnostic(error: unknown): SharedProviderErrorDiagnostic | undefined {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0 && seen.size < 12) {
    const current = pending.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    pending.push(diagnosticProperty(current, "lastError"), diagnosticProperty(current, "cause"));
    if (diagnosticProperty(current, "name") !== "AI_APICallError") continue;
    const data = diagnosticProperty(current, "data");
    const raw = diagnosticProperty(current, "responseBody");
    const dataState =
      data === DIAGNOSTIC_ACCESSOR_MISS
        ? "unreadable"
        : data == null
          ? "absent"
          : typeof data === "object"
            ? "object"
            : typeof data === "string"
              ? "string"
              : "other";
    let responseBodyState =
      raw === DIAGNOSTIC_ACCESSOR_MISS
        ? "unreadable"
        : raw == null
          ? "absent"
          : typeof raw !== "string"
            ? "other"
            : raw.length === 0
              ? "empty"
              : raw.length > 32768
                ? "oversized"
                : "non_json";
    const projections: Array<{
      fields: SharedProviderErrorDiagnostic;
      shape: string;
      source: string;
    }> = [];
    if (dataState === "object" || dataState === "string")
      projections.push({ ...providerEnvelope(data), source: "data" });
    if (typeof raw === "string" && raw.length > 0 && raw.length <= 32768) {
      try {
        projections.push({ ...providerEnvelope(JSON.parse(raw)), source: "response_body" });
        responseBodyState = "json";
      } catch {
        // error-policy:J7 non-JSON provider bodies are inspected only for closed patterns.
        projections.push({
          fields: providerErrorFields(undefined, raw),
          shape: "plain_text",
          source: "response_body",
        });
      }
    }
    const sdkMessage = diagnosticProperty(current, "message");
    if (typeof sdkMessage === "string" && sdkMessage.length <= 4096)
      projections.push({
        fields: providerErrorFields(undefined, sdkMessage),
        shape: "sdk_message",
        source: "sdk_message",
      });
    const selected =
      projections.find(
        (candidate) =>
          candidate.fields.category !== "unknown" &&
          candidate.fields.category !== "invalid_request",
      ) ??
      projections.find((candidate) => candidate.fields.category !== "unknown") ??
      projections[0];
    return {
      ...(selected?.fields ?? providerErrorFields(undefined)),
      source: selected?.source ?? "none",
      shape: selected?.shape ?? "none",
      dataState,
      responseBodyState,
    };
  }
  return undefined;
}

function parseProviderErrorDiagnostic(value: unknown): SharedProviderErrorDiagnostic | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.category !== "string" ||
    !PROVIDER_ERROR_CATEGORIES.has(v.category) ||
    typeof v.type !== "string" ||
    !PROVIDER_ERROR_TYPES.has(v.type) ||
    typeof v.code !== "string" ||
    !PROVIDER_ERROR_CODES.has(v.code) ||
    typeof v.parameterClass !== "string" ||
    !PROVIDER_ERROR_PARAMETERS.has(v.parameterClass)
  )
    return undefined;
  const states: Record<string, unknown> = {};
  for (const [key, allowed] of [
    ["source", PROVIDER_ERROR_SOURCES],
    ["shape", PROVIDER_ERROR_SHAPES],
    ["dataState", PROVIDER_DATA_STATES],
    ["responseBodyState", PROVIDER_BODY_STATES],
  ] as const) {
    if (v[key] !== undefined) {
      if (typeof v[key] !== "string" || !allowed.has(v[key] as string)) return undefined;
      states[key] = v[key];
    }
  }
  return {
    category: v.category,
    type: v.type,
    code: v.code,
    parameterClass: v.parameterClass,
    ...states,
  };
}

/** Safe numeric/classification projection; never carries SDK messages, headers or payloads. */
export function sharedModelFailureDiagnostic(
  error: unknown,
  operation: SharedModelFailureDiagnostic["operation"],
): SharedModelFailureDiagnostic {
  const name = error instanceof Error ? error.name : "UnknownError";
  const code = error instanceof ElizaError ? error.code : undefined;
  const providerError = providerErrorDiagnostic(error);
  return {
    operation,
    diagnosticSchemaVersion: 2,
    errorName: MODEL_FAILURE_NAMES.has(name) ? name : "UnknownError",
    ...(code && MODEL_FAILURE_CODES.has(code) ? { diagnosticCode: code } : {}),
    ...classifySharedRuntimeTurnFailure(error),
    ...(providerError ? { providerError } : {}),
  };
}

/** Rebuild only a bounded allowlist at the internal transport boundary. */
export function parseSharedRuntimeFailureDiagnostic(
  value: unknown,
): SharedRuntimeFailureDiagnostic | undefined {
  try {
    if (!value || typeof value !== "object") return undefined;
    const v = value as Record<string, unknown>;
    if (
      (v.diagnosticSchemaVersion !== undefined && v.diagnosticSchemaVersion !== 2) ||
      typeof v.modelInvocationStarted !== "boolean" ||
      typeof v.terminalFailurePresent !== "boolean" ||
      typeof v.terminalMode !== "string" ||
      !TERMINAL_MODES.has(v.terminalMode) ||
      typeof v.failureKind !== "string"
    )
      return undefined;
    for (const field of ["processingSuccess", "didRespond", "responseErrorPresent"] as const) {
      if (v[field] !== undefined && v[field] !== null && typeof v[field] !== "boolean")
        return undefined;
    }
    let lastModelCompletion: SharedModelCompletionDiagnostic | null = null;
    if (v.lastModelCompletion !== null) {
      if (!v.lastModelCompletion || typeof v.lastModelCompletion !== "object") return undefined;
      const c = v.lastModelCompletion as Record<string, unknown>;
      if (
        (c.operation !== "generate" && c.operation !== "stream") ||
        typeof c.textPresent !== "boolean" ||
        typeof c.finishClass !== "string" ||
        !COMPLETION_CLASSES.has(c.finishClass) ||
        (c.toolCount !== null &&
          (typeof c.toolCount !== "number" ||
            !Number.isSafeInteger(c.toolCount) ||
            c.toolCount < 0 ||
            c.toolCount > 64))
      )
        return undefined;
      if (
        (c.sdkReasoningTokens !== undefined &&
          c.sdkReasoningTokens !== null &&
          (typeof c.sdkReasoningTokens !== "number" ||
            !Number.isSafeInteger(c.sdkReasoningTokens) ||
            c.sdkReasoningTokens < 0 ||
            c.sdkReasoningTokens > 4_000_000)) ||
        (c.providerReasoningDetailPresent !== undefined &&
          c.providerReasoningDetailPresent !== null &&
          typeof c.providerReasoningDetailPresent !== "boolean")
      )
        return undefined;
      lastModelCompletion = {
        operation: c.operation,
        ...(c.sdkReasoningTokens !== undefined
          ? { sdkReasoningTokens: c.sdkReasoningTokens as number | null }
          : {}),
        ...(c.providerReasoningDetailPresent !== undefined
          ? { providerReasoningDetailPresent: c.providerReasoningDetailPresent as boolean | null }
          : {}),
        textPresent: c.textPresent,
        toolCount: c.toolCount as number | null,
        finishClass: c.finishClass as SharedModelCompletionDiagnostic["finishClass"],
      };
    }
    let modelFailure: SharedModelFailureDiagnostic | undefined;
    if (v.modelFailure !== undefined) {
      if (!v.modelFailure || typeof v.modelFailure !== "object") return undefined;
      const m = v.modelFailure as Record<string, unknown>;
      const failureName = parseSharedRuntimeTurnFailureName(m.failureName);
      const providerError =
        m.providerError === undefined ? undefined : parseProviderErrorDiagnostic(m.providerError);
      if (
        (m.diagnosticSchemaVersion !== undefined && m.diagnosticSchemaVersion !== 2) ||
        typeof m.operation !== "string" ||
        !MODEL_OPERATIONS.has(m.operation) ||
        typeof m.errorName !== "string" ||
        (m.errorName !== "UnknownError" && !MODEL_FAILURE_NAMES.has(m.errorName)) ||
        failureName === null ||
        typeof m.retryable !== "boolean" ||
        SHARED_RUNTIME_TURN_RETRY_DISPOSITION[failureName] !== m.retryable ||
        (m.providerStatus !== undefined && boundedProviderStatus(m.providerStatus) === null) ||
        (m.diagnosticCode !== undefined &&
          (typeof m.diagnosticCode !== "string" || !MODEL_FAILURE_CODES.has(m.diagnosticCode))) ||
        (m.providerError !== undefined && providerError === undefined)
      )
        return undefined;
      modelFailure = {
        operation: m.operation as SharedModelFailureDiagnostic["operation"],
        ...(m.diagnosticSchemaVersion !== undefined ? { diagnosticSchemaVersion: 2 as const } : {}),
        errorName: m.errorName,
        failureName,
        retryable: m.retryable,
        ...(m.providerStatus !== undefined ? { providerStatus: m.providerStatus as number } : {}),
        ...(m.diagnosticCode !== undefined ? { diagnosticCode: m.diagnosticCode as string } : {}),
        ...(providerError ? { providerError } : {}),
      };
    }
    return {
      ...(v.diagnosticSchemaVersion !== undefined ? { diagnosticSchemaVersion: 2 as const } : {}),
      modelInvocationStarted: v.modelInvocationStarted,
      ...(v.processingSuccess !== undefined
        ? { processingSuccess: v.processingSuccess as boolean | null }
        : {}),
      ...(v.didRespond !== undefined ? { didRespond: v.didRespond as boolean | null } : {}),
      ...(v.responseErrorPresent !== undefined
        ? { responseErrorPresent: v.responseErrorPresent as boolean | null }
        : {}),
      failureKind: RUNTIME_FAILURE_KINDS.has(v.failureKind) ? v.failureKind : "unknown",
      terminalFailurePresent: v.terminalFailurePresent,
      terminalMode: v.terminalMode as SharedRuntimeFailureDiagnostic["terminalMode"],
      lastModelCompletion,
      ...(modelFailure ? { modelFailure } : {}),
    };
  } catch {
    // error-policy:J7 hostile diagnostic accessors are metadata misses, never turn failures.
    return undefined;
  }
}

// Weak, isolate-local metadata leaves SDK errors and cause identity untouched.
const runtimeFailureDiagnostics = new WeakMap<object, SharedRuntimeFailureDiagnostic>();
export function recordSharedRuntimeFailureDiagnostic(
  error: unknown,
  value: SharedRuntimeFailureDiagnostic | (() => SharedRuntimeFailureDiagnostic),
): void {
  try {
    const diagnostic = parseSharedRuntimeFailureDiagnostic(
      typeof value === "function" ? value() : value,
    );
    if (diagnostic && typeof error === "object" && error !== null)
      runtimeFailureDiagnostics.set(error, { ...diagnostic, diagnosticSchemaVersion: 2 });
  } catch {
    // error-policy:J7 diagnostic projection can never replace the original failure.
  }
}
function findSharedRuntimeFailureDiagnostic(
  error: unknown,
): SharedRuntimeFailureDiagnostic | undefined {
  try {
    for (const item of errorChain(error)) {
      if (typeof item !== "object" || item === null) continue;
      const diagnostic = runtimeFailureDiagnostics.get(item);
      if (diagnostic) return diagnostic;
    }
    return undefined;
  } catch {
    // error-policy:J7 a diagnostic cause walk cannot replace the original classification.
    return undefined;
  }
}

/**
 * Adds turn identity while retaining a bounded failure class and disposition.
 * Raw provider/action messages remain only on `cause` inside the isolate.
 */
export class SharedRuntimeTurnError extends ElizaError {
  override readonly name = "SharedRuntimeTurnError";
  readonly failureName: SharedRuntimeTurnFailureName;
  readonly retryable: boolean;
  readonly failureDiagnostic?: SharedRuntimeFailureDiagnostic;

  constructor(
    message: string,
    cause: unknown,
    classification?: SharedRuntimeTurnFailureClassification,
    diagnostic?: unknown,
  ) {
    const resolved = classification ?? classifySharedRuntimeTurnFailure(cause);
    const safeDiagnostic =
      parseSharedRuntimeFailureDiagnostic(diagnostic) ?? findSharedRuntimeFailureDiagnostic(cause);
    super(message, {
      code: "SHARED_RUNTIME_TURN_FAILED",
      context: {
        failureName: resolved.failureName,
        retryable: resolved.retryable,
      },
      cause,
      severity: resolved.retryable ? "ephemeral" : "fatal",
    });
    this.failureName = resolved.failureName;
    this.retryable = resolved.retryable;
    if (safeDiagnostic) this.failureDiagnostic = safeDiagnostic;
  }

  /**
   * Rehydrate only sanitized, allowlisted metadata after a Durable Object
   * fetch. Invalid or inconsistent input fails closed as a terminal unknown
   * error instead of trusting transport-controlled classification.
   */
  static fromClassification(
    failureName: unknown,
    retryable: unknown,
    diagnostic?: unknown,
  ): SharedRuntimeTurnError {
    const parsedName = parseSharedRuntimeTurnFailureName(failureName);
    const classificationIsConsistent =
      parsedName !== null &&
      typeof retryable === "boolean" &&
      SHARED_RUNTIME_TURN_RETRY_DISPOSITION[parsedName] === retryable;
    const safeClassification: SharedRuntimeTurnFailureClassification = classificationIsConsistent
      ? { failureName: parsedName, retryable }
      : {
          failureName: "SharedRuntimeUnknownError",
          retryable: false,
        };
    return new SharedRuntimeTurnError(
      "Shared runtime turn failed.",
      new Error("Sanitized shared runtime failure crossed the coordinator boundary."),
      safeClassification,
      classificationIsConsistent ? diagnostic : undefined,
    );
  }
}
