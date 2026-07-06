/**
 * The three vision backends behind one interface. Anthropic uses the Messages
 * API with a base64 image block; OpenAI and the local llama-server Qwen3-VL
 * share the OpenAI chat.completions path with an image_url data URI, differing
 * only by base URL (`ELIZA_VISION_QA_BASE_URL`) — so `openai-compatible` is one
 * builder used for both.
 *
 * Every backend is forced to emit strict JSON `{answers: [{id, answer,
 * confidence, details}]}`. The parser REJECTS non-conforming output with a
 * typed error rather than regex-rescuing a partial answer — a fabricated or
 * mis-parsed vision answer is worse than a loud failure. `askAboutImage` spends
 * at most one corrective retry (counted in provenance) before giving up. Token
 * usage is read from the provider response, never estimated; a response with no
 * usage block fails, because a Q&A record without real usage is not evidence.
 */

import { z } from "zod";
import { EvidenceError } from "../errors.ts";
import type { PreparedImage } from "./image.ts";
import type { TokenUsage, VisionAnswer, VisionQuestion } from "./types.ts";

/** Default model per backend; overridable via `AskOptions.model`. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
export const DEFAULT_LOCAL_MODEL = "qwen3-vl";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2023-06-01";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Output ceiling: enough for a structured answer per question, not prose. */
const MAX_OUTPUT_TOKENS = 2048;

/**
 * System rubric shared by every backend and prompt-cacheable on Anthropic. Kept
 * verbatim-stable so the cache key (model + questions) is meaningful and so a
 * nightly Message-Batches sweep reuses the cached prefix.
 */
export const SYSTEM_RUBRIC =
  "You are a meticulous UI screenshot reviewer. You answer specific questions " +
  "about a single screenshot. Look only at what is visible; do not speculate " +
  "about behavior you cannot see. For each question, give a direct answer, a " +
  "confidence in [0,1] reflecting how clearly the screenshot supports it, and " +
  "brief supporting details naming the concrete visual evidence. Respond with " +
  "ONLY a JSON object of the exact shape " +
  '{"answers":[{"id":string,"answer":string,"confidence":number,"details":string}]} ' +
  "— one entry per question id, no markdown, no code fences, no prose outside the JSON.";

/** The corrective message appended on the single retry after a parse failure. */
export const RETRY_CORRECTION =
  "Your previous reply was not valid JSON of the required shape. Reply with " +
  "ONLY the JSON object " +
  '{"answers":[{"id":string,"answer":string,"confidence":number,"details":string}]} ' +
  "and nothing else.";

/** Render the questions as a stable, numbered instruction block. */
export function renderQuestionPrompt(questions: VisionQuestion[]): string {
  const lines = questions.map((q) => `- id "${q.id}": ${q.question}`);
  return `Answer each of these questions about the screenshot:\n${lines.join("\n")}`;
}

const answerSchema = z.strictObject({
  id: z.string().min(1),
  answer: z.string(),
  confidence: z.number().min(0).max(1),
  details: z.string(),
});

const responseSchema = z.strictObject({
  answers: z.array(answerSchema),
});

/**
 * Parse a model's raw text into validated answers covering exactly the asked
 * ids. Throws `VISION_RESPONSE_INVALID` on malformed JSON, wrong shape,
 * out-of-range confidence, or an id set that does not match the questions —
 * never a partial/rescued result. The caller retries once on this error.
 */
export function parseAnswers(
  raw: string,
  questions: VisionQuestion[],
): VisionAnswer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // error-policy:J3 untrusted model output — non-JSON is a typed invalid
    // result the caller retries against, not a silently-empty answer set.
    throw new EvidenceError("vision-qa response was not valid JSON", {
      code: "VISION_RESPONSE_INVALID",
      cause: error,
      context: { rawPreview: raw.slice(0, 200) },
    });
  }
  const result = responseSchema.safeParse(parsed);
  if (!result.success) {
    throw new EvidenceError("vision-qa response did not match the schema", {
      code: "VISION_RESPONSE_INVALID",
      context: {
        issues: result.error.issues.map((i) => ({
          path: i.path.map(String).join("."),
          message: i.message,
        })),
      },
    });
  }
  const asked = new Set(questions.map((q) => q.id));
  const answered = new Set(result.data.answers.map((a) => a.id));
  if (
    asked.size !== answered.size ||
    [...asked].some((id) => !answered.has(id))
  ) {
    throw new EvidenceError(
      "vision-qa answer ids do not match the asked question ids",
      {
        code: "VISION_RESPONSE_INVALID",
        context: { asked: [...asked], answered: [...answered] },
      },
    );
  }
  return result.data.answers;
}

/** A backend HTTP request: everything `fetch` needs plus the target URL. */
export interface BackendRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Extracted from a backend response: the raw answer text and token usage. */
export interface BackendResponse {
  text: string;
  usage: TokenUsage;
}

/**
 * A vision backend: builds the wire request (with an optional corrective turn)
 * and extracts the answer text + usage from the parsed response body. Pure and
 * synchronous so request shapes are unit-testable without a network.
 */
export interface VisionBackendClient {
  readonly model: string;
  buildRequest(
    image: PreparedImage,
    questions: VisionQuestion[],
    correction: string | null,
  ): BackendRequest;
  extractResponse(responseBody: unknown): BackendResponse;
}

// --- Anthropic Messages ----------------------------------------------------

const anthropicResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

export class AnthropicBackend implements VisionBackendClient {
  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string = ANTHROPIC_BASE_URL,
  ) {}

  buildRequest(
    image: PreparedImage,
    questions: VisionQuestion[],
    correction: string | null,
  ): BackendRequest {
    const userContent: unknown[] = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: image.mediaType,
          data: image.base64,
        },
      },
      { type: "text", text: renderQuestionPrompt(questions) },
    ];
    if (correction !== null) {
      userContent.push({ type: "text", text: correction });
    }
    const body = {
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_RUBRIC,
      messages: [{ role: "user", content: userContent }],
    };
    return {
      url: `${this.baseUrl}/messages`,
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    };
  }

  extractResponse(responseBody: unknown): BackendResponse {
    const parsed = anthropicResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new EvidenceError("anthropic response shape was unexpected", {
        code: "VISION_BACKEND_RESPONSE",
        context: { backend: "anthropic" },
      });
    }
    const text = parsed.data.content
      .filter((block) => block.type === "text" && block.text !== undefined)
      .map((block) => block.text)
      .join("");
    if (text.length === 0) {
      throw new EvidenceError("anthropic response had no text content", {
        code: "VISION_BACKEND_RESPONSE",
        context: { backend: "anthropic" },
      });
    }
    return {
      text,
      usage: {
        inputTokens: parsed.data.usage.input_tokens,
        outputTokens: parsed.data.usage.output_tokens,
      },
    };
  }
}

// --- OpenAI-compatible (OpenAI + local llama-server) -----------------------

const openAiResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({ content: z.string().nullable() }),
    }),
  ),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
  }),
});

export class OpenAiCompatibleBackend implements VisionBackendClient {
  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  buildRequest(
    image: PreparedImage,
    questions: VisionQuestion[],
    correction: string | null,
  ): BackendRequest {
    const dataUri = `data:${image.mediaType};base64,${image.base64}`;
    const userContent: unknown[] = [
      { type: "text", text: renderQuestionPrompt(questions) },
      { type: "image_url", image_url: { url: dataUri } },
    ];
    if (correction !== null) {
      userContent.push({ type: "text", text: correction });
    }
    const body = {
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_RUBRIC },
        { role: "user", content: userContent },
      ],
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    // The local llama-server path needs no key; OpenAI does. Only send the
    // header when a key exists so a keyless local server is not handed a bogus
    // "Bearer " prefix it would reject.
    if (this.apiKey.length > 0) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    return {
      url: `${this.baseUrl}/chat/completions`,
      headers,
      body: JSON.stringify(body),
    };
  }

  extractResponse(responseBody: unknown): BackendResponse {
    const parsed = openAiResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new EvidenceError(
        "openai-compatible response shape was unexpected",
        {
          code: "VISION_BACKEND_RESPONSE",
          context: { backend: "openai-compatible" },
        },
      );
    }
    const text = parsed.data.choices[0]?.message.content;
    if (text === undefined || text === null || text.length === 0) {
      throw new EvidenceError(
        "openai-compatible response had no message content",
        {
          code: "VISION_BACKEND_RESPONSE",
          context: { backend: "openai-compatible" },
        },
      );
    }
    return {
      text,
      usage: {
        inputTokens: parsed.data.usage.prompt_tokens,
        outputTokens: parsed.data.usage.completion_tokens,
      },
    };
  }
}
