import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { logger, ModelType, VECTOR_DIMS } from "@elizaos/core";
import { createOpenAI } from "@ai-sdk/openai";
import { embed, type LanguageModelUsage } from "ai";
import {
  getApiKey,
  getEmbeddingBaseURL,
  getEmbeddingInputType,
  getEmbeddingModel,
  getSetting,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

/** NIM embed routes are case-sensitive; docs use lowercase org (e.g. baai/bge-m3). */
function normalizeEmbeddingModelId(model: string): string {
  const i = model.indexOf("/");
  if (i <= 0) return model;
  return `${model.slice(0, i).toLowerCase()}${model.slice(i)}`;
}

function isEmbeddingDebug(runtime: IAgentRuntime): boolean {
  const v = getSetting(runtime, "NVIDIA_EMBEDDING_DEBUG");
  if (!v) return false;
  const s = v.toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/** Safe log line: no API key, truncate long input previews. */
function summarizeEmbeddingBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const input = body.input;
  const preview =
    typeof input === "string"
      ? { kind: "string", length: input.length, preview: input.slice(0, 120) }
      : Array.isArray(input)
        ? {
            kind: "array",
            length: input.length,
            firstLen:
              typeof input[0] === "string" ? input[0].length : undefined,
            preview:
              typeof input[0] === "string"
                ? String(input[0]).slice(0, 120)
                : undefined,
          }
        : { kind: typeof input };
  return {
    model: body.model,
    keys: Object.keys(body),
    input: preview,
    input_type: body.input_type,
    encoding_format: body.encoding_format,
    truncate: body.truncate,
  };
}

function collectNimHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const want = ["nvcf-reqid", "nvcf-status", "x-request-id", "nv-request-id"];
  headers.forEach((value, key) => {
    if (want.includes(key.toLowerCase())) {
      out[key] = value;
    }
  });
  return out;
}

function embeddingFetchHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "elizaOS-plugin-nvidiacloud (https://elizaos.ai)",
  };
}

function languageModelUsage(
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
): LanguageModelUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
  };
}

type EmbedAttempt = { name: string; body: Record<string, unknown> };

function buildEmbeddingAttempts(
  model: string,
  text: string,
  inputType: "passage" | "query" | undefined,
): EmbedAttempt[] {
  // NVIDIA embedding models are OpenAI-like, not OpenAI-identical. Some require
  // `input_type`, and older endpoints differ on string vs array input shapes.
  // Trying a small ordered set keeps memory indexing working across models.
  if (inputType) {
    return [
      {
        name: "nv-embed-string",
        body: {
          model,
          input: text,
          input_type: inputType,
          encoding_format: "float",
          truncate: "NONE",
        },
      },
      {
        name: "nv-embed-array",
        body: {
          model,
          input: [text],
          input_type: inputType,
          encoding_format: "float",
          truncate: "NONE",
        },
      },
    ];
  }
  return [
    {
      name: "string+float+truncate",
      body: { model, input: text, encoding_format: "float", truncate: "NONE" },
    },
    {
      name: "array+float+truncate",
      body: {
        model,
        input: [text],
        encoding_format: "float",
        truncate: "NONE",
      },
    },
    { name: "array-only", body: { model, input: [text] } },
    { name: "string-only", body: { model, input: text } },
  ];
}

function parseEmbeddingResponse(textBody: string): {
  data?: Array<{ embedding?: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
} {
  try {
    return JSON.parse(textBody) as {
      data?: Array<{ embedding?: number[] }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
  } catch {
    throw new Error(
      `NVIDIA embeddings: invalid JSON in response (${textBody.slice(0, 200)})`,
    );
  }
}

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null,
): Promise<number[]> {
  const embeddingDimension = Number.parseInt(
    getSetting(runtime, "NVIDIA_EMBEDDING_DIMENSIONS") ??
      getSetting(runtime, "EMBEDDING_DIMENSIONS") ??
      "1024",
    10,
  ) as (typeof VECTOR_DIMS)[keyof typeof VECTOR_DIMS];

  if (!Object.values(VECTOR_DIMS).includes(embeddingDimension)) {
    const errorMsg = `Invalid embedding dimension: ${embeddingDimension}. Must be one of: ${Object.values(VECTOR_DIMS).join(", ")}`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  if (params === null) {
    const testVector = Array(embeddingDimension).fill(0);
    testVector[0] = 0.1;
    return testVector;
  }

  let text: string;
  if (typeof params === "string") {
    text = params;
  } else if (
    typeof params === "object" &&
    params &&
    "text" in params &&
    params.text
  ) {
    text = params.text;
  } else {
    logger.warn("Invalid input format for embedding");
    const fallbackVector = Array(embeddingDimension).fill(0);
    fallbackVector[0] = 0.2;
    return fallbackVector;
  }

  if (!text.trim()) {
    logger.warn("Empty text for embedding");
    const fallbackVector = Array(embeddingDimension).fill(0);
    fallbackVector[0] = 0.3;
    return fallbackVector;
  }

  const apiKey = getApiKey(runtime);
  if (!apiKey) {
    throw new Error("NVIDIA_API_KEY (or NVIDIA_CLOUD_API_KEY) is not set");
  }

  const baseURL = getEmbeddingBaseURL(runtime);
  const embedUrl = `${baseURL}/embeddings`;
  const model = normalizeEmbeddingModelId(getEmbeddingModel(runtime));
  const inputType = getEmbeddingInputType(runtime);
  const embedDebug = isEmbeddingDebug(runtime);
  const attempts = buildEmbeddingAttempts(model, text, inputType);

  logger.debug(
    `[NVIDIA NIM] embeddings → ${embedUrl} model=${model} inputChars=${text.length} attempts=${attempts.length}`,
  );
  if (embedDebug) {
    logger.debug(
      {
        attempts: attempts.map((a) => ({
          name: a.name,
          body: summarizeEmbeddingBody(a.body),
        })),
      },
      "[NVIDIA NIM] EMBEDDING_DEBUG bodies",
    );
  }

  let lastStatus = 0;
  let lastStatusText = "";
  let lastBody = "";
  let lastHeaders: Record<string, string> = {};

  if (!inputType) {
    // Prefer the AI SDK for standard embedding models so usage accounting and
    // provider behavior stay consistent. NVIDIA-specific models fall through to
    // raw HTTP because the SDK does not expose fields such as `input_type`.
    try {
      const openai = createOpenAI({
        baseURL: baseURL,
        apiKey,
      });
      const { embedding, usage } = await embed({
        model: openai.embedding(model),
        value: text,
      });
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error("AI SDK embed returned empty embedding");
      }
      if (embedding.length !== embeddingDimension) {
        throw new Error(
          `Embedding length ${embedding.length} does not match NVIDIA_EMBEDDING_DIMENSIONS=${embeddingDimension}`,
        );
      }
      if (usage) {
        const u = usage as Record<string, number | undefined>;
        const inputTokens = Number(
          u.inputTokens ?? u.promptTokens ?? u.tokens ?? 0,
        );
        const outputTokens = Number(u.outputTokens ?? 0);
        const totalTokens = Number(u.totalTokens ?? inputTokens + outputTokens);
        emitModelUsageEvent(
          runtime,
          ModelType.TEXT_EMBEDDING,
          languageModelUsage(inputTokens, outputTokens, totalTokens),
          model,
          "TEXT_EMBEDDING",
        );
      }
      logger.debug("[NVIDIA NIM] embeddings OK via AI SDK embed()");
      return embedding;
    } catch (aiErr: unknown) {
      const msg = aiErr instanceof Error ? aiErr.message : String(aiErr);
      logger.warn(
        { error: msg },
        "[NVIDIA NIM] AI SDK embed() failed, falling back to raw HTTP",
      );
    }
  }

  for (const { name, body } of attempts) {
    if (embedDebug) {
      logger.debug(
        { attempt: name, body: summarizeEmbeddingBody(body) },
        "[NVIDIA NIM] embeddings request",
      );
    }
    try {
      const response = await fetch(embedUrl, {
        method: "POST",
        headers: embeddingFetchHeaders(apiKey),
        body: JSON.stringify(body),
      });

      const responseText = await response.text();
      lastStatus = response.status;
      lastStatusText = response.statusText;
      lastBody = responseText;
      lastHeaders = collectNimHeaders(response.headers);

      if (response.ok) {
        const data = parseEmbeddingResponse(responseText);
        const embedding = data?.data?.[0]?.embedding;
        if (!Array.isArray(embedding)) {
          logger.error(
            {
              attempt: name,
              sample: responseText.slice(0, 400),
              headers: lastHeaders,
            },
            "[NVIDIA NIM] embeddings: OK but unexpected JSON shape",
          );
          throw new Error("API returned invalid embedding structure");
        }
        if (embedding.length !== embeddingDimension) {
          const errorMsg = `Embedding length ${embedding.length} does not match configured dimension ${embeddingDimension} (set NVIDIA_EMBEDDING_DIMENSIONS)`;
          logger.error(
            { attempt: name, ...lastHeaders, errorMsg },
            "[NVIDIA NIM] embeddings dimension mismatch",
          );
          throw new Error(errorMsg);
        }
        if (name !== "string+float+truncate" && name !== "nv-embed-string") {
          logger.info(
            `[NVIDIA NIM] embeddings succeeded with attempt "${name}" (consider setting this shape as default)`,
          );
        }
        if (data.usage) {
          const usage = languageModelUsage(
            data.usage.prompt_tokens ?? 0,
            0,
            data.usage.total_tokens ?? data.usage.prompt_tokens ?? 0,
          );
          emitModelUsageEvent(
            runtime,
            ModelType.TEXT_EMBEDDING,
            usage,
            model,
            "TEXT_EMBEDDING",
          );
        }
        return embedding;
      }

      logger.warn(
        {
          attempt: name,
          status: response.status,
          statusText: response.statusText,
          nimHeaders: lastHeaders,
          bodyPreview: responseText.slice(0, 500),
        },
        "[NVIDIA NIM] embeddings attempt failed",
      );

      const retryable =
        response.status === 500 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 422 ||
        response.status === 400;
      if (!retryable) {
        break;
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("invalid JSON")) {
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(
        { attempt: name, error: msg },
        "[NVIDIA NIM] embeddings fetch error (will try next shape if any)",
      );
    }
  }

  const reqId = lastHeaders["nvcf-reqid"] ?? lastHeaders["NVCF-REQID"] ?? "n/a";
  logger.error(
    {
      url: embedUrl,
      model,
      lastStatus,
      lastStatusText,
      nimHeaders: lastHeaders,
      responsePreview: lastBody.slice(0, 800),
      hint: embedDebug
        ? "NVIDIA_EMBEDDING_DEBUG already on — check model id and NVIDIA_EMBEDDING_DIMENSIONS vs model output size."
        : "Set NVIDIA_EMBEDDING_DEBUG=1 for full attempt bodies in logs.",
      buildHint:
        "Default embed model is nvidia/nv-embedqa-e5-v5 (passage for memory). Enable it on https://build.nvidia.com; if bge-m3 500s for your key, keep this default or set NVIDIA_EMBEDDING_MODEL explicitly from the model page.",
    },
    "[NVIDIA NIM] embeddings failed after all attempts",
  );
  throw new Error(
    `NVIDIA embeddings error: ${lastStatus} ${lastStatusText} (NVCF-REQID=${reqId}). ` +
      "Chat may work while embeddings return 500 if this model is not enabled for your API key on NVIDIA Build, quotas are exhausted, or the embed fleet is down — try another NVIDIA_EMBEDDING_MODEL or contact NVIDIA support with NVCF-REQID.",
  );
}
