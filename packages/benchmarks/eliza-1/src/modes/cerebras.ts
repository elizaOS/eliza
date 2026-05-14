/**
 * Cerebras reference mode.
 *
 * Calls Cerebras's OpenAI-compatible chat completions endpoint
 * (`https://api.cerebras.ai/v1/chat/completions`) with the request's JSON
 * schema threaded as an OpenAI-style `tools` / `tool_choice` argument. If the
 * tool path returns no text, falls back to JSON-schema response mode and then
 * prompt-only JSON. The model's structured output is unwrapped to JSON for
 * parity with the eliza-1 modes.
 *
 * Default model is `llama3.1-8b` — the baseline for eliza-1 tiers 0.8B
 * through 9B. For the 27B tier (which should be benched on an H200), pass
 * `--cerebras-model gpt-oss-120b` or construct with `{ model: "gpt-oss-120b" }`.
 *
 * Skipped (with a logged reason) when `CEREBRAS_API_KEY` is absent so the
 * bench is safe to run in CI without secrets.
 */
import { approxTokens } from "../metrics.ts";
import type {
  JsonValue,
  ModeAdapter,
  ModeRequest,
  ModeResult,
  SkeletonFreeField,
} from "../types.ts";

const CEREBRAS_ENDPOINT = "https://api.cerebras.ai/v1/chat/completions";
const DEFAULT_MODEL = "llama3.1-8b";

/**
 * Structural type for the Cerebras chat completions endpoint. We don't depend
 * on `openai` or `@cerebras/cerebras_cloud_sdk` — raw `fetch` keeps the bench
 * dep-light and lets tests inject a mock without touching network.
 */
export interface CerebrasClient {
  chatCompletions(req: CerebrasRequest): Promise<CerebrasResponse>;
}

interface CerebrasRequest {
  model: string;
  max_tokens: number;
  temperature?: number;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: JsonValue;
    };
  }>;
  tool_choice?: {
    type: "function";
    function: { name: string };
  };
  response_format?:
    | { type: "json_object" }
    | {
        type: "json_schema";
        json_schema: {
          name: string;
          strict: boolean;
          schema: JsonValue;
        };
      };
}

interface CerebrasResponse {
  choices: Array<{
    message: {
      role: "assistant";
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface CerebrasModeOptions {
  model?: string;
  apiKey?: string;
  endpoint?: string;
  /** Optional injection point for tests. */
  client?: CerebrasClient;
}

type CerebrasAttemptKind = "tool-use" | "json-schema" | "prompt-only";

interface CerebrasAttempt {
  kind: CerebrasAttemptKind;
  request: CerebrasRequest;
}

interface ExtractedOutput {
  rawOutput: string;
  tokens: number;
  emptyDiagnostic: string | null;
}

export class CerebrasAdapterError extends Error {
  readonly attemptErrors: string[];

  constructor(message: string, attemptErrors: string[]) {
    super(message);
    this.name = "CerebrasAdapterError";
    this.attemptErrors = attemptErrors;
  }
}

export class CerebrasMode implements ModeAdapter {
  readonly id = "cerebras" as const;
  private client: CerebrasClient | null = null;
  private skipReason: string | null = null;
  private resolved = false;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly endpoint: string;
  private readonly injectedClient: CerebrasClient | undefined;

  constructor(options: CerebrasModeOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.apiKey = options.apiKey ?? process.env.CEREBRAS_API_KEY;
    this.endpoint = options.endpoint ?? CEREBRAS_ENDPOINT;
    this.injectedClient = options.client;
  }

  async available(): Promise<string | null> {
    if (this.resolved) return this.skipReason;
    this.resolved = true;
    if (this.injectedClient) {
      this.client = this.injectedClient;
      return null;
    }
    if (!this.apiKey) {
      this.skipReason = "CEREBRAS_API_KEY is not set — skipping cerebras mode";
      return this.skipReason;
    }
    this.client = createFetchClient(this.endpoint, this.apiKey);
    return null;
  }

  async generate(req: ModeRequest): Promise<ModeResult> {
    if (!this.client) {
      return emptyResult(this.skipReason ?? "cerebras client unavailable");
    }
    const toolName = req.taskId.startsWith("action:")
      ? req.taskId.replace(/[^A-Za-z0-9_]/g, "_")
      : req.taskId;
    const parameters = buildToolParameters(req);
    const messages: CerebrasRequest["messages"] = [];
    if (req.systemPrompt) {
      messages.push({ role: "system", content: req.systemPrompt });
    }
    messages.push({ role: "user", content: req.userPrompt });

    const startedAt = Date.now();
    const warnings: string[] = [];
    const transportErrors: string[] = [];
    const emptyDiagnostics: string[] = [];
    let lastTokens = 0;
    const attempts = buildAttempts({
      model: this.model,
      maxTokens: req.maxTokens,
      taskId: req.taskId,
      toolName,
      parameters,
      messages,
    });

    for (const attempt of attempts) {
      try {
        const response = await this.client.chatCompletions(attempt.request);
        const totalLatencyMs = Date.now() - startedAt;
        const extracted = extractRawOutput(response, attempt.kind);
        lastTokens = extracted.tokens;
        if (extracted.emptyDiagnostic) {
          emptyDiagnostics.push(extracted.emptyDiagnostic);
          warnings.push(extracted.emptyDiagnostic);
          continue;
        }
        return {
          rawOutput: extracted.rawOutput,
          firstTokenLatencyMs: null,
          totalLatencyMs,
          tokensGenerated: extracted.tokens,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      } catch (err) {
        const message = `${attempt.kind}: ${formatErrorMessage(err)}`;
        transportErrors.push(message);
        warnings.push(message);
      }
    }

    const totalLatencyMs = Date.now() - startedAt;
    if (transportErrors.length > 0) {
      throw new CerebrasAdapterError(
        [
          "cerebras adapter failed before producing a usable benchmark response",
          ...emptyDiagnostics,
          ...transportErrors,
        ].join("; "),
        transportErrors,
      );
    }

    return {
      rawOutput: "",
      firstTokenLatencyMs: null,
      totalLatencyMs,
      tokensGenerated: lastTokens,
      warnings,
      error: [
        "cerebras returned empty output after tool-use, json-schema, and prompt-only attempts",
        ...emptyDiagnostics,
      ].join("; "),
    };
  }
}

function buildAttempts(args: {
  model: string;
  maxTokens: number;
  taskId: string;
  toolName: string;
  parameters: JsonValue;
  messages: CerebrasRequest["messages"];
}): CerebrasAttempt[] {
  const jsonMessages = buildJsonMessages(args.messages, args.parameters);
  return [
    {
      kind: "tool-use",
      request: {
        model: args.model,
        max_tokens: args.maxTokens,
        temperature: 0,
        messages: args.messages,
        tools: [
          {
            type: "function",
            function: {
              name: args.toolName,
              description: `Emit the structured output for task ${args.taskId}.`,
              parameters: args.parameters,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: args.toolName } },
      },
    },
    {
      kind: "json-schema",
      request: {
        model: args.model,
        max_tokens: args.maxTokens,
        temperature: 0,
        messages: jsonMessages,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: responseFormatName(args.toolName),
            strict: true,
            schema: args.parameters,
          },
        },
      },
    },
    {
      kind: "prompt-only",
      request: {
        model: args.model,
        max_tokens: args.maxTokens,
        temperature: 0,
        messages: jsonMessages,
      },
    },
  ];
}

function createFetchClient(endpoint: string, apiKey: string): CerebrasClient {
  return {
    async chatCompletions(req) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(req),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`cerebras ${res.status}: ${detail.slice(0, 240)}`);
      }
      return (await res.json()) as CerebrasResponse;
    },
  };
}

function buildJsonMessages(
  messages: CerebrasRequest["messages"],
  parameters: JsonValue,
): CerebrasRequest["messages"] {
  const out = messages.map((message) => ({ ...message }));
  const jsonInstruction =
    "Return only a JSON object that matches the requested schema. Do not include markdown fences, prose, comments, or tool-call wrappers.";
  if (out[0]?.role === "system") {
    out[0] = {
      ...out[0],
      content: `${out[0].content}\n${jsonInstruction}`,
    };
  } else {
    out.unshift({ role: "system", content: jsonInstruction });
  }
  out.push({
    role: "user",
    content: [
      "Use this JSON schema for the response object:",
      JSON.stringify(parameters),
    ].join("\n"),
  });
  return out;
}

function responseFormatName(toolName: string): string {
  const cleaned = toolName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "eliza_1_response";
}

function extractRawOutput(
  response: CerebrasResponse,
  attemptKind: CerebrasAttemptKind,
): ExtractedOutput {
  const first = response.choices[0];
  const toolCalls = first?.message.tool_calls ?? [];
  for (const toolCall of toolCalls) {
    const args = toolCall.function.arguments;
    if (typeof args === "string" && args.trim().length > 0) {
      return {
        rawOutput: args,
        tokens: response.usage?.completion_tokens ?? approxTokens(args),
        emptyDiagnostic: null,
      };
    }
  }

  const content = first?.message.content;
  if (typeof content === "string" && content.trim().length > 0) {
    return {
      rawOutput: content,
      tokens: response.usage?.completion_tokens ?? approxTokens(content),
      emptyDiagnostic: null,
    };
  }

  const tokens = response.usage?.completion_tokens ?? 0;
  return {
    rawOutput: "",
    tokens,
    emptyDiagnostic: describeEmptyResponse(response, attemptKind, tokens),
  };
}

function describeEmptyResponse(
  response: CerebrasResponse,
  attemptKind: CerebrasAttemptKind,
  completionTokens: number,
): string {
  const first = response.choices[0];
  const content = first?.message.content;
  const contentChars = typeof content === "string" ? content.length : 0;
  const contentState =
    content === null
      ? "null"
      : typeof content === "string"
        ? `${contentChars} chars`
        : "missing";
  const details = [
    `choices=${response.choices.length}`,
    `finish_reason=${first?.finish_reason ?? "missing"}`,
    `tool_calls=${first?.message.tool_calls?.length ?? 0}`,
    `content=${contentState}`,
    `completion_tokens=${completionTokens}`,
  ].join(", ");
  return `cerebras ${attemptKind} returned empty output (${details})`;
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Translate the bench's `SkeletonHint` into a JSON schema usable as the
 * function-tool's `parameters`. Wraps the user-provided `jsonSchema` when one
 * is set, otherwise synthesises from the skeleton fields.
 */
function buildToolParameters(req: ModeRequest): JsonValue {
  if (
    req.jsonSchema &&
    typeof req.jsonSchema === "object" &&
    !Array.isArray(req.jsonSchema)
  ) {
    return req.jsonSchema;
  }
  const hint = req.skeletonHint;
  if (hint.enumKey && hint.enumValues) {
    return {
      type: "object",
      properties: {
        [hint.enumKey]: {
          type: "string",
          enum: hint.enumValues,
        },
      },
      required: [hint.enumKey],
      additionalProperties: false,
    };
  }
  const properties: Record<string, JsonValue> = {};
  const required: string[] = [];
  for (const field of hint.freeFields) {
    properties[field.key] = fieldToSchema(field);
    required.push(field.key);
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: true,
  };
}

function fieldToSchema(field: SkeletonFreeField): JsonValue {
  switch (field.kind) {
    case "enum":
      return { type: "string", enum: field.enumValues ?? [] };
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "object":
      return { type: "object" };
  }
}

function emptyResult(message: string): ModeResult {
  return {
    rawOutput: "",
    firstTokenLatencyMs: null,
    totalLatencyMs: 0,
    tokensGenerated: 0,
    error: message,
  };
}
