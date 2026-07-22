/**
 * One-shot Claude Agent SDK completion adapter. Every call creates and closes
 * a fresh SDK query; temporary MCP handlers only capture proposed tool calls.
 */

import { tmpdir } from "node:os";
import { z } from "zod";
import type {
  CapturedToolCall,
  ClaudeCompletionResult,
  CompletionContext,
  CompletionRunner,
  CompletionUsage,
  JsonObject,
  NormalizedFunctionTool,
} from "./types.js";

export const CLAUDE_AGENT_SDK_VERSION = "0.3.200" as const;
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const MCP_SERVER_NAME = "benchmark";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

interface SdkToolDefinition {
  readonly __gatewayToolName?: string;
}

interface SdkQuery extends AsyncIterable<SdkMessage> {
  accountInfo: () => Promise<SdkAccountInfo>;
  close?: () => void;
}

interface SdkAccountInfo {
  apiProvider?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
}

interface SdkMessage {
  type: string;
  subtype?: string;
  is_error?: boolean;
  apiKeySource?: string;
  result?: string;
  terminal_reason?: string;
  usage?: Record<string, unknown>;
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
  model?: string;
  claude_code_version?: string;
  error?:
    | "authentication_failed"
    | "oauth_org_not_allowed"
    | "billing_error"
    | "rate_limit"
    | "overloaded"
    | "invalid_request"
    | "model_not_found"
    | "server_error"
    | "unknown"
    | "max_output_tokens";
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  rate_limit_info?: {
    status: "allowed" | "allowed_warning" | "rejected";
    resetsAt?: number;
    rateLimitType?: string;
  };
}

export interface ClaudeAgentSdkModule {
  query(options: {
    prompt: string;
    options: Record<string, unknown>;
  }): SdkQuery;
  tool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>,
  ): SdkToolDefinition;
  createSdkMcpServer(options: {
    name: string;
    version?: string;
    tools: SdkToolDefinition[];
  }): unknown;
}

export interface ClaudeSdkCompletionRunnerOptions {
  sdkModule?: ClaudeAgentSdkModule;
  sdkLoader?: () => Promise<ClaudeAgentSdkModule>;
  timeoutMs?: number;
  cwd?: string;
  claudeExecutablePath?: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
}

export class ClaudeCompletionError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(
    code: string,
    message: string,
    statusCode = 502,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClaudeCompletionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ClaudeRateLimitError extends ClaudeCompletionError {
  readonly retryAtMs: number | null;
  readonly rateLimitType: string | null;
  readonly rateLimitStatus: "rejected";

  constructor(
    retryAtMs: number | null,
    rateLimitType: string | null,
    options?: ErrorOptions,
  ) {
    super(
      "subscription_rate_limited",
      "The Claude subscription is rate limited.",
      429,
      options,
    );
    this.name = "ClaudeRateLimitError";
    this.retryAtMs = retryAtMs;
    this.rateLimitType = rateLimitType;
    this.rateLimitStatus = "rejected";
  }
}

export class ClaudeCredentialPolicyError extends Error {
  readonly code = "api_billing_environment_forbidden";

  constructor() {
    super(
      "API-billing environment variables must be removed before starting the Claude subscription gateway.",
    );
    this.name = "ClaudeCredentialPolicyError";
  }
}

export class ClaudeSdkCompletionRunner implements CompletionRunner {
  private readonly sdkOverride?: ClaudeAgentSdkModule;
  private readonly sdkLoader: () => Promise<ClaudeAgentSdkModule>;
  private readonly timeoutMs: number;
  private readonly cwd: string;
  private readonly claudeExecutablePath?: string;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;

  constructor(options: ClaudeSdkCompletionRunnerOptions = {}) {
    this.sdkOverride = options.sdkModule;
    this.sdkLoader = options.sdkLoader ?? loadSdkModule;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 120_000, "timeoutMs");
    this.cwd = options.cwd ?? tmpdir();
    this.claudeExecutablePath = options.claudeExecutablePath;
    this.environment = options.environment ?? process.env;
  }

  async complete(context: CompletionContext): Promise<ClaudeCompletionResult> {
    const sdk = await this.loadSdk();
    const captured: CapturedToolCall[] = [];
    const tools = selectedTools(context);
    let sdkTools: SdkToolDefinition[];
    try {
      sdkTools = tools.map((tool) =>
        this.createCaptureTool(sdk, context.requestId, tool, captured),
      );
    } catch (error: unknown) {
      // error-policy:J2 SDK tool registration is an upstream boundary; retain
      // the cause while exposing only a stable classification to callers.
      throw redactSdkFailure(
        error,
        "claude_sdk_tool_configuration_failed",
        "The Claude Agent SDK could not configure the requested tools.",
      );
    }
    const qualifiedToolNames = tools.map(
      (tool) => `${MCP_TOOL_PREFIX}${tool.function.name}`,
    );
    const options: Record<string, unknown> = {
      model: context.canonical.request.model,
      systemPrompt: context.canonical.systemPrompt,
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      // Only the explicitly allowed capture tools may run. `dontAsk` denies
      // every unmatched permission in a headless session, whereas
      // `bypassPermissions` approves the entire available surface and requires
      // a dangerous-override flag that this gateway does not need.
      permissionMode: "dontAsk",
      maxTurns: 1,
      cwd: this.cwd,
      // The SDK's `tools` option is the base Claude Code built-in set. MCP
      // tools come from `mcpServers` and are permissioned independently via
      // `allowedTools`; putting qualified MCP names in `tools` produces an
      // invalid upstream request instead of exposing the capture server.
      tools: [],
      allowedTools: qualifiedToolNames,
      env: buildClaudeCodeManagedEnvironment(
        this.environment,
        context.credentialOAuthToken,
      ),
    };
    if (context.canonical.request.reasoningEffort) {
      options.effort = context.canonical.request.reasoningEffort;
    }
    if (this.claudeExecutablePath) {
      options.pathToClaudeCodeExecutable = this.claudeExecutablePath;
    }
    if (sdkTools.length > 0) {
      try {
        options.mcpServers = {
          [MCP_SERVER_NAME]: sdk.createSdkMcpServer({
            name: MCP_SERVER_NAME,
            version: "1.0.0",
            tools: sdkTools,
          }),
        };
      } catch (error: unknown) {
        // error-policy:J2 MCP server construction is an upstream boundary;
        // retain the cause without returning SDK text to the HTTP client.
        throw redactSdkFailure(
          error,
          "claude_sdk_tool_configuration_failed",
          "The Claude Agent SDK could not configure the requested tools.",
        );
      }
    }

    const abortController = new AbortController();
    options.abortController = abortController;
    let query: SdkQuery;
    try {
      query = sdk.query({ prompt: context.canonical.prompt, options });
    } catch (error: unknown) {
      // error-policy:J2 query construction is an upstream process boundary;
      // retain the cause while exposing only the controlled failure code.
      throw redactSdkFailure(
        error,
        "claude_sdk_query_start_failed",
        "The Claude Agent SDK could not start a completion session.",
        503,
      );
    }
    const consume = consumeSdkQuery(
      query,
      captured,
      context.credentialTierValidator,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abortController.abort();
        query.close?.();
        reject(
          new ClaudeCompletionError(
            "claude_sdk_timeout",
            "The Claude Agent SDK request exceeded the gateway deadline.",
            504,
          ),
        );
      }, this.timeoutMs);
    });

    let consumed: ConsumedSdkQuery;
    try {
      consumed = await Promise.race([consume, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      query.close?.();
    }
    validateCompletionContract(context, consumed, captured);
    return {
      text: consumed.text,
      toolCalls: captured,
      model: consumed.model,
      claudeCodeVersion: consumed.claudeCodeVersion,
      sdkApiKeySource: "none",
      resultSubtype: consumed.resultSubtype,
      terminalReason: consumed.terminalReason,
      subscriptionType: consumed.subscriptionType,
      usage: consumed.usage,
    };
  }

  private async loadSdk(): Promise<ClaudeAgentSdkModule> {
    if (this.sdkOverride) return this.sdkOverride;
    try {
      return await this.sdkLoader();
    } catch (error: unknown) {
      // error-policy:J2 module loading is an upstream package boundary; keep
      // loader details in the cause and return a fixed availability failure.
      throw redactSdkFailure(
        error,
        "claude_sdk_load_failed",
        "The Claude Agent SDK could not be loaded.",
        503,
      );
    }
  }

  private createCaptureTool(
    sdk: ClaudeAgentSdkModule,
    requestId: string,
    tool: NormalizedFunctionTool,
    captured: CapturedToolCall[],
  ): SdkToolDefinition {
    const shape = zodShapeFromJsonSchema(
      tool.function.parameters,
      tool.function.name,
    );
    return sdk.tool(
      tool.function.name,
      tool.function.description,
      shape,
      async (args) => {
        const argumentsObject = jsonObjectFromToolArguments(
          args,
          tool.function.name,
        );
        captured.push({
          id: `call_${requestId}_${captured.length + 1}`,
          name: tool.function.name,
          arguments: argumentsObject,
        });
        return {
          content: [
            {
              type: "text",
              text: "Benchmark tool call captured. The calling agent runtime will execute it.",
            },
          ],
        };
      },
    );
  }
}

interface ConsumedSdkQuery {
  text: string;
  model: string;
  claudeCodeVersion: string;
  resultSubtype: string;
  terminalReason: string | null;
  usage: CompletionUsage;
  subscriptionType: string;
}

async function consumeSdkQuery(
  query: SdkQuery,
  captured: readonly CapturedToolCall[],
  credentialTierValidator?: (subscriptionType: string) => void,
): Promise<ConsumedSdkQuery> {
  let account: SdkAccountInfo;
  try {
    account = await query.accountInfo();
  } catch (error: unknown) {
    // error-policy:J2 account initialization crosses the Claude Code process
    // boundary; preserve its cause without exposing upstream authentication text.
    throw redactSdkFailure(
      error,
      "claude_sdk_account_info_failed",
      "Claude Code could not initialize its subscription account.",
      503,
    );
  }
  const subscriptionType = assertSubscriptionAccount(account);
  credentialTierValidator?.(subscriptionType);
  let text = "";
  let model: string | null = null;
  let claudeCodeVersion: string | null = null;
  let sdkAuthSource: "oauth" | null = null;
  let resultMessage: SdkMessage | null = null;
  try {
    for await (const message of query) {
      if (
        message.type === "rate_limit_event" &&
        message.rate_limit_info?.status === "rejected"
      ) {
        throw new ClaudeRateLimitError(
          normalizeResetTimestampMs(message.rate_limit_info.resetsAt),
          typeof message.rate_limit_info.rateLimitType === "string"
            ? message.rate_limit_info.rateLimitType
            : null,
        );
      }
      if (message.type === "assistant" && message.error) {
        throw structuredAssistantError(message.error);
      }
      if (
        message.type === "system" &&
        message.subtype === "api_retry" &&
        message.attempt === message.max_retries
      ) {
        if (message.error === "rate_limit" || message.error_status === 429) {
          throw new ClaudeRateLimitError(null, null);
        }
        if (
          message.error === "authentication_failed" ||
          message.error === "oauth_org_not_allowed"
        ) {
          throw new ClaudeCompletionError(
            "claude_sdk_authentication_failed",
            "Claude Code rejected the subscription credential.",
            401,
          );
        }
      }
      if (message.type === "system" && message.subtype === "init") {
        // Agent SDK 0.3.200's bundled Claude Code 2.1.200 reports `none` for a
        // keychain-backed claude.ai session. The account control response is the
        // authoritative discriminator: it must identify a first-party paid/free
        // subscription and must not identify any API-key source.
        if (
          message.apiKeySource !== "oauth" &&
          message.apiKeySource !== "none"
        ) {
          throw new ClaudeCompletionError(
            "claude_sdk_non_subscription_auth",
            "Claude Code did not initialize with OAuth subscription credentials.",
            503,
          );
        }
        sdkAuthSource = "oauth";
        model = typeof message.model === "string" ? message.model : model;
        claudeCodeVersion =
          typeof message.claude_code_version === "string"
            ? message.claude_code_version
            : claudeCodeVersion;
      }
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string")
            text += block.text;
        }
      }
      if (message.type === "result") resultMessage = message;
    }
  } catch (error: unknown) {
    // error-policy:J1 Agent SDK 0.3.200 yields the structured max-turn result
    // before rejecting iteration for Claude Code's nonzero tool-stop exit. A
    // captured handler plus the exact terminal envelope is authoritative;
    // every pre-result or differently classified rejection remains a failure.
    if (!isCapturedToolTerminal(resultMessage, captured)) {
      throw redactSdkFailure(
        error,
        "claude_sdk_stream_failed",
        "The Claude Agent SDK completion stream failed.",
      );
    }
  }
  if (!resultMessage) {
    throw new ClaudeCompletionError(
      "claude_sdk_missing_result",
      "The Claude Agent SDK session ended without a result envelope.",
    );
  }
  if (sdkAuthSource === null) {
    throw new ClaudeCompletionError(
      "claude_sdk_missing_auth_provenance",
      "Claude Code did not report a controlled authentication source.",
      503,
    );
  }
  if (!model) {
    throw new ClaudeCompletionError(
      "claude_sdk_missing_model_provenance",
      "Claude Code did not report the effective model.",
      503,
    );
  }
  if (!claudeCodeVersion) {
    throw new ClaudeCompletionError(
      "claude_sdk_missing_version_provenance",
      "Claude Code did not report its runtime version.",
      503,
    );
  }
  if (typeof resultMessage.subtype !== "string" || !resultMessage.subtype) {
    throw new ClaudeCompletionError(
      "claude_sdk_missing_result_subtype",
      "The Claude Agent SDK result omitted its subtype.",
    );
  }
  const usage = parseUsage(resultMessage.usage);
  if (
    !text.trim() &&
    resultMessage.subtype === "success" &&
    typeof resultMessage.result === "string"
  ) {
    text = resultMessage.result;
  }
  return {
    text: text.trim(),
    model,
    claudeCodeVersion,
    resultSubtype: resultMessage.subtype,
    terminalReason:
      typeof resultMessage.terminal_reason === "string"
        ? resultMessage.terminal_reason
        : null,
    subscriptionType,
    usage,
  };
}

function isCapturedToolTerminal(
  resultMessage: SdkMessage | null,
  captured: readonly CapturedToolCall[],
): boolean {
  return (
    captured.length > 0 &&
    resultMessage?.type === "result" &&
    resultMessage.subtype === "error_max_turns" &&
    resultMessage.is_error === true &&
    resultMessage.terminal_reason === "max_turns"
  );
}

function redactSdkFailure(
  error: unknown,
  code: string,
  message: string,
  statusCode = 502,
): ClaudeCompletionError {
  if (error instanceof ClaudeCompletionError) return error;
  return new ClaudeCompletionError(code, message, statusCode, { cause: error });
}

function assertSubscriptionAccount(account: SdkAccountInfo): string {
  const subscriptionType = account.subscriptionType?.trim();
  const apiKeySource = account.apiKeySource?.trim().toLowerCase();
  if (
    account.apiProvider !== "firstParty" ||
    !subscriptionType ||
    (apiKeySource !== undefined &&
      apiKeySource !== "" &&
      apiKeySource !== "none" &&
      apiKeySource !== "oauth")
  ) {
    throw new ClaudeCompletionError(
      "claude_sdk_non_subscription_account",
      "Claude Code did not report a first-party Claude subscription account.",
      503,
    );
  }
  return subscriptionType;
}

export const FORBIDDEN_API_BILLING_ENV_NAMES = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_AUTH",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_API_KEY",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_SCOPE",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_UNIX_SOCKET",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "BEDROCK_AUTH",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "CLOUD_ML_REGION",
  "VERTEX_AUTH",
  "AZURE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "FOUNDRY_AUTH",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_CCR_V2",
]);
const EXPLICIT_RAW_CREDENTIAL_VARIABLES = new Set(
  FORBIDDEN_API_BILLING_ENV_NAMES,
);

export function assertNoApiBillingEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
): void {
  if (
    Object.entries(source).some(
      ([name, value]) =>
        typeof value === "string" && value && isApiBillingVariable(name),
    )
  ) {
    throw new ClaudeCredentialPolicyError();
  }
}

export function buildClaudeCodeManagedEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  credentialOAuthToken?: string,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string" || isRawCredentialVariable(name)) continue;
    environment[name] = value;
  }
  if (credentialOAuthToken !== undefined) {
    if (!credentialOAuthToken.trim()) {
      throw new ClaudeCredentialPolicyError();
    }
    environment.CLAUDE_CODE_OAUTH_TOKEN = credentialOAuthToken;
  }
  environment.CLAUDE_AGENT_SDK_CLIENT_APP =
    "elizaos-claude-subscription-gateway/0.1.0";
  return environment;
}

function isRawCredentialVariable(name: string): boolean {
  const normalized = name.toUpperCase();
  if (normalized === "CLAUDE_CODE_OAUTH_TOKEN") return false;
  if (normalized.startsWith("ANTHROPIC_")) return true;
  if (EXPLICIT_RAW_CREDENTIAL_VARIABLES.has(normalized)) return true;
  return /(?:^|_)(?:API_KEY|TOKEN|AUTH_TOKEN|ACCESS_TOKEN|BEARER_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|PASSWORD|CREDENTIALS?)$/.test(
    normalized,
  );
}

function isApiBillingVariable(name: string): boolean {
  const normalized = name.toUpperCase();
  if (normalized === "CLAUDE_CODE_OAUTH_TOKEN") return false;
  return EXPLICIT_RAW_CREDENTIAL_VARIABLES.has(normalized);
}

function validateCompletionContract(
  context: CompletionContext,
  consumed: ConsumedSdkQuery,
  captured: CapturedToolCall[],
): void {
  const choice = context.canonical.request.toolChoice;
  if (!context.canonical.request.parallelToolCalls && captured.length > 1) {
    throw new ClaudeCompletionError(
      "claude_sdk_parallel_tool_calls_forbidden",
      "Claude emitted multiple tool calls for a request that disabled parallel tool calls.",
    );
  }
  if (
    (choice === "required" || typeof choice === "object") &&
    captured.length === 0
  ) {
    throw new ClaudeCompletionError(
      "claude_sdk_required_tool_missing",
      "Claude did not emit the tool call required by this request.",
    );
  }
  if (captured.length > 0) return;
  if (consumed.resultSubtype !== "success") {
    throw new ClaudeCompletionError(
      "claude_sdk_unsuccessful_result",
      "The Claude Agent SDK returned a non-success result without a captured tool call.",
    );
  }
  if (!consumed.text) {
    throw new ClaudeCompletionError(
      "claude_sdk_empty_completion",
      "The Claude Agent SDK returned an empty completion.",
    );
  }
  if (isProviderErrorEnvelope(consumed.text)) {
    if (isRateLimitProse(consumed.text)) {
      throw new ClaudeRateLimitError(null, null);
    }
    throw new ClaudeCompletionError(
      "claude_sdk_provider_error",
      "The Claude Agent SDK returned a provider error envelope.",
    );
  }
}

function isProviderErrorEnvelope(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    /^api error:\s*\d{3}\b/.test(normalized) ||
    (/^you'?ve (hit|reached|exceeded) your\b/.test(normalized) &&
      /\blimit\b/.test(normalized)) ||
    /\bclaude( ai)? usage limit reached\s*\|/.test(normalized)
  );
}

function isRateLimitProse(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    /^api error:\s*429\b/.test(normalized) ||
    (/^you'?ve (hit|reached|exceeded) your\b/.test(normalized) &&
      /\blimit\b/.test(normalized)) ||
    /\bclaude( ai)? usage limit reached\s*\|/.test(normalized)
  );
}

function structuredAssistantError(
  error: NonNullable<SdkMessage["error"]>,
): ClaudeCompletionError {
  if (error === "rate_limit") return new ClaudeRateLimitError(null, null);
  if (error === "authentication_failed" || error === "oauth_org_not_allowed") {
    return new ClaudeCompletionError(
      "claude_sdk_authentication_failed",
      "Claude Code rejected the subscription credential.",
      401,
    );
  }
  return new ClaudeCompletionError(
    `claude_sdk_assistant_${error}`,
    "The Claude Agent SDK returned a structured assistant error.",
    error === "overloaded" || error === "server_error" ? 503 : 502,
  );
}

export function normalizeResetTimestampMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  return Number.isSafeInteger(milliseconds) && milliseconds <= 8_640_000_000_000_000
    ? milliseconds
    : null;
}

function selectedTools(context: CompletionContext): NormalizedFunctionTool[] {
  const { tools, toolChoice } = context.canonical.request;
  if (toolChoice === "none") return [];
  if (typeof toolChoice === "object") {
    return tools.filter(
      (tool) => tool.function.name === toolChoice.function.name,
    );
  }
  return tools;
}

function zodShapeFromJsonSchema(
  parameters: JsonObject,
  toolName: string,
): Record<string, unknown> {
  let converted: z.ZodType;
  try {
    converted = z.fromJSONSchema(
      parameters as Parameters<typeof z.fromJSONSchema>[0],
    );
  } catch (_error) {
    // error-policy:J3 the caller supplied an invalid JSON Schema; translate it
    // into an explicit configuration failure without retaining schema content.
    throw new ClaudeCompletionError(
      "invalid_tool_json_schema",
      `Tool ${toolName} has a JSON Schema that the gateway cannot compile.`,
      422,
    );
  }
  if (!(converted instanceof z.ZodObject)) {
    throw new ClaudeCompletionError(
      "non_object_tool_json_schema",
      `Tool ${toolName} parameters must compile to an object schema.`,
      422,
    );
  }
  return converted.shape;
}

function jsonObjectFromToolArguments(
  args: Record<string, unknown>,
  toolName: string,
): JsonObject {
  if (!isJsonObject(args)) {
    throw new ClaudeCompletionError(
      "invalid_captured_tool_arguments",
      `Tool ${toolName} emitted non-JSON arguments.`,
    );
  }
  return args;
}

function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function parseUsage(value: unknown): CompletionUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClaudeCompletionError(
      "claude_sdk_missing_usage",
      "The Claude Agent SDK result omitted its usage envelope.",
    );
  }
  return {
    inputTokens: requiredUsageNumber(value, "input_tokens"),
    outputTokens: requiredUsageNumber(value, "output_tokens"),
    cacheReadInputTokens: requiredUsageNumber(value, "cache_read_input_tokens"),
    cacheCreationInputTokens: requiredUsageNumber(
      value,
      "cache_creation_input_tokens",
    ),
  };
}

function requiredUsageNumber(value: object, key: string): number {
  const item = Reflect.get(value, key);
  if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
    throw new ClaudeCompletionError(
      "claude_sdk_invalid_usage",
      "The Claude Agent SDK result contained an invalid usage envelope.",
    );
  }
  return item;
}

async function loadSdkModule(): Promise<ClaudeAgentSdkModule> {
  const loaded: unknown = await import(SDK_PACKAGE);
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    typeof Reflect.get(loaded, "query") !== "function" ||
    typeof Reflect.get(loaded, "tool") !== "function" ||
    typeof Reflect.get(loaded, "createSdkMcpServer") !== "function"
  ) {
    throw new ClaudeCompletionError(
      "claude_sdk_unavailable",
      "The installed Claude Agent SDK has an unexpected module shape.",
      503,
    );
  }
  return loaded as ClaudeAgentSdkModule;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `[ClaudeSubscriptionGateway] ${label} must be a positive integer`,
    );
  }
  return value;
}
