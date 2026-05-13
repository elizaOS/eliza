/**
 * Cerebras reference mode.
 *
 * Calls Cerebras's OpenAI-compatible chat completions endpoint
 * (`https://api.cerebras.ai/v1/chat/completions`) with the request's JSON
 * schema threaded as an OpenAI-style `tools` / `tool_choice` argument. The
 * model's tool call is unwrapped to JSON for parity with the eliza-1 modes.
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

export interface CerebrasRequest {
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
}

export interface CerebrasResponse {
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
    try {
      const response = await this.client.chatCompletions({
        model: this.model,
        max_tokens: req.maxTokens,
        temperature: 0,
        messages,
        tools: [
          {
            type: "function",
            function: {
              name: toolName,
              description: `Emit the structured output for task ${req.taskId}.`,
              parameters,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: toolName } },
      });
      const totalLatencyMs = Date.now() - startedAt;
      const first = response.choices[0];
      const toolCall = first?.message.tool_calls?.[0];
      let rawOutput = "";
      if (toolCall) {
        rawOutput = toolCall.function.arguments;
      } else if (first?.message.content) {
        rawOutput = first.message.content;
      }
      const usage = response.usage;
      const tokens = usage ? usage.completion_tokens : approxTokens(rawOutput);
      return {
        rawOutput,
        firstTokenLatencyMs: null,
        totalLatencyMs,
        tokensGenerated: tokens,
      };
    } catch (err) {
      return {
        rawOutput: "",
        firstTokenLatencyMs: null,
        totalLatencyMs: Date.now() - startedAt,
        tokensGenerated: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
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

/**
 * Translate the bench's `SkeletonHint` into a JSON schema usable as the
 * function-tool's `parameters`. Wraps the user-provided `jsonSchema` when one
 * is set, otherwise synthesises from the skeleton fields.
 */
export function buildToolParameters(req: ModeRequest): JsonValue {
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
