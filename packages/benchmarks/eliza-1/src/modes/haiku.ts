/**
 * Haiku reference mode.
 *
 * Calls Anthropic's `claude-haiku-4-5-20251001` with the request's JSON schema
 * threaded as a tool-use parameter schema. The model's tool call is unwrapped
 * to JSON for parity with the eliza-1 modes.
 *
 * Skipped (with a logged reason) when `ANTHROPIC_API_KEY` is absent so the
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

/**
 * Anthropic SDK call options. Re-declared as a structural type so the runner
 * tests can plug in a mock without depending on `@anthropic-ai/sdk`'s exported
 * types directly (which can churn between minor versions).
 */
export interface HaikuClient {
  messages: {
    create(req: HaikuRequest): Promise<HaikuResponse>;
  };
}

export interface HaikuRequest {
  model: string;
  max_tokens: number;
  temperature?: number;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools?: Array<{
    name: string;
    description: string;
    input_schema: JsonValue;
  }>;
  tool_choice?: { type: "tool"; name: string };
}

export interface HaikuResponse {
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; name: string; input: JsonValue }
  >;
}

export interface HaikuModeOptions {
  model?: string;
  apiKey?: string;
  /** Optional injection point for tests. */
  client?: HaikuClient;
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export class HaikuMode implements ModeAdapter {
  readonly id = "haiku" as const;
  private client: HaikuClient | null = null;
  private skipReason: string | null = null;
  private resolved = false;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly injectedClient: HaikuClient | undefined;

  constructor(options: HaikuModeOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
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
      this.skipReason = "ANTHROPIC_API_KEY is not set — skipping haiku mode";
      return this.skipReason;
    }
    try {
      const Anthropic = (await import("@anthropic-ai/sdk")) as unknown as {
        default: new (args: { apiKey: string }) => HaikuClient;
      };
      this.client = new Anthropic.default({ apiKey: this.apiKey });
      return null;
    } catch (err) {
      this.skipReason = `failed to import @anthropic-ai/sdk: ${
        err instanceof Error ? err.message : String(err)
      }`;
      return this.skipReason;
    }
  }

  async generate(req: ModeRequest): Promise<ModeResult> {
    if (!this.client) {
      return emptyResult(this.skipReason ?? "haiku client unavailable");
    }
    const toolName = req.taskId.startsWith("action:")
      ? req.taskId.replace(/[^A-Za-z0-9_]/g, "_")
      : req.taskId;
    const inputSchema = buildToolInputSchema(req);
    const startedAt = Date.now();
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens,
        temperature: 0,
        system: req.systemPrompt,
        messages: [{ role: "user", content: req.userPrompt }],
        tools: [
          {
            name: toolName,
            description: `Emit the structured output for task ${req.taskId}.`,
            input_schema: inputSchema,
          },
        ],
        tool_choice: { type: "tool", name: toolName },
      });
      const totalLatencyMs = Date.now() - startedAt;
      const toolUse = response.content.find(
        (b): b is { type: "tool_use"; name: string; input: JsonValue } =>
          b.type === "tool_use",
      );
      let rawOutput = "";
      if (toolUse) {
        rawOutput = JSON.stringify(toolUse.input);
      } else {
        const text = response.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
        rawOutput = text;
      }
      const usage = response.usage;
      const tokens = usage ? usage.output_tokens : approxTokens(rawOutput);
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

/**
 * Translate the bench's `SkeletonHint` into a JSON schema usable as
 * `tool.input_schema`. Wraps the user-provided `jsonSchema` when one is set,
 * otherwise synthesises from the skeleton fields.
 */
export function buildToolInputSchema(req: ModeRequest): JsonValue {
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
