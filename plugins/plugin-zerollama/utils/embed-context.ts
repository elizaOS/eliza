/**
 * Resolves a safe character budget for Ollama / zerollama embedding inputs.
 *
 * Embedding models advertise a small `context_length` (e.g. embeddinggemma =
 * 2048). A naive ~8k-token soft cap still 400s on English prose because the
 * host refuses to truncate further once the tokenizer exceeds that window.
 * Prefer the advertised context with a conservative chars-per-token ratio, and
 * fall back to a known-safe default when the daemon cannot be probed.
 */
import { logger, toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";

/** Hard ceiling so a huge advertised context cannot blow memory on one embed. */
export const EMBED_SOFT_CAP_CHARS = 32_000;

/**
 * English prose on embeddinggemma (ctx 2048) can fail above ~1000 chars on
 * denser corpora (character bios / knowledge dumps); keep the unknown-context
 * default at that measured ceiling.
 */
export const EMBED_SAFE_DEFAULT_CHARS = 1_000;

/**
 * Worst-case chars/token for mixed English + markup. Measured against
 * embeddinggemma:300m on zerollama (2048 ctx → denser knowledge text fails
 * around 1100 chars; 0.45 keeps headroom under the tokenizer window).
 */
const CONSERVATIVE_CHARS_PER_TOKEN = 0.45;

const contextCache = new Map<string, number>();

export function embedMaxCharsForContext(contextLength: number): number {
  if (!Number.isFinite(contextLength) || contextLength <= 0) {
    return EMBED_SAFE_DEFAULT_CHARS;
  }
  return Math.max(
    256,
    Math.min(EMBED_SOFT_CAP_CHARS, Math.floor(contextLength * CONSERVATIVE_CHARS_PER_TOKEN))
  );
}

export function truncateEmbedInput(input: string | string[], maxChars: number): string | string[] {
  if (typeof input === "string") {
    const wellFormed = toWellFormedUnicode(input);
    if (wellFormed.length <= maxChars) return wellFormed;
    logger.warn(
      `[Ollama] Embedding input too long (${wellFormed.length} chars), truncating to ${maxChars}`
    );
    return truncateWellFormed(wellFormed, maxChars);
  }
  return input.map((text) => {
    const wellFormed = toWellFormedUnicode(text);
    if (wellFormed.length <= maxChars) return wellFormed;
    return truncateWellFormed(wellFormed, maxChars);
  });
}

export function isEmbedContextOverflow(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.message} ${
          "responseBody" in error &&
          typeof (error as { responseBody?: unknown }).responseBody === "string"
            ? (error as { responseBody: string }).responseBody
            : ""
        }`
      : String(error);
  return /exceeds maximum context length|context length|too long|n_ctx/i.test(message);
}

/** Read `context_length` from `/api/tags` (cached per apiBase+model). */
export async function resolveEmbedMaxChars(options: {
  apiBase: string;
  model: string;
  fetchImpl?: typeof fetch;
  envMaxChars?: string | undefined;
}): Promise<number> {
  const envCap = Number(options.envMaxChars);
  if (Number.isFinite(envCap) && envCap > 0) {
    return Math.min(EMBED_SOFT_CAP_CHARS, Math.floor(envCap));
  }

  const cacheKey = `${options.apiBase}::${options.model}`;
  const cached = contextCache.get(cacheKey);
  if (cached !== undefined) {
    return embedMaxCharsForContext(cached);
  }

  const fetcher = options.fetchImpl ?? fetch;
  try {
    const response = await fetcher(`${options.apiBase}/api/tags`);
    if (!response.ok) {
      return EMBED_SAFE_DEFAULT_CHARS;
    }
    const body = (await response.json()) as {
      models?: Array<{
        name?: string;
        model?: string;
        details?: { context_length?: number };
      }>;
    };
    const models = Array.isArray(body.models) ? body.models : [];
    const hit = models.find((row) => row.name === options.model || row.model === options.model);
    const ctx = hit?.details?.context_length;
    if (typeof ctx === "number" && ctx > 0) {
      contextCache.set(cacheKey, ctx);
      return embedMaxCharsForContext(ctx);
    }
  } catch (error) {
    // error-policy:J4 probe-only — fall back to the safe default budget.
    logger.debug(
      {
        src: "plugin:ollama",
        model: options.model,
        error: error instanceof Error ? error.message : String(error),
      },
      "[Ollama] Could not probe embedding context_length; using safe default"
    );
  }

  return EMBED_SAFE_DEFAULT_CHARS;
}

/** Test helper — clears the tags cache between cases. */
export function clearEmbedContextCache(): void {
  contextCache.clear();
}
