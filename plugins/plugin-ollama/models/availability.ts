/**
 * Ensures a model exists on the Ollama server before inference: probes `/api/show` and, when the
 * model is absent, issues a blocking `/api/pull`. Runs ahead of every text and embedding call
 * (`models/text.ts`, `models/embedding.ts`), so a first-use miss adds download latency.
 *
 * ## Failure policy (#12796)
 *
 * Model discovery / auto-download is a local-inference bootstrap path: "not installed", "daemon
 * unreachable", and "pull failed" are all distinct failures that MUST reach the caller — never a
 * silent return that lets inference proceed against a model the daemon does not have. Swallowing
 * the pull failure here previously converted a broken/absent model into a "healthy, proceed" state:
 * the subsequent generate/embed call then failed deep in the AI SDK with an opaque error (or, for
 * some daemon versions, produced a confusing 404), losing the actionable "download failed" signal.
 *
 * A successful `/api/show` (or a benign "model already present" 200) returns normally. Anything
 * else throws a typed `OllamaModelUnavailableError` carrying the wire status so the outer text /
 * embedding handler surfaces it to the model/caller (both call sites throw on error — see
 * `models/text.ts` and `models/embedding.ts`).
 */
import { logger } from "@elizaos/core";

/**
 * Raised when a model cannot be confirmed present on the Ollama daemon and cannot be pulled.
 * Distinguishes the bootstrap-time failure from a downstream inference error so callers (and the
 * agent) see "the local model is not available", not a generic completion failure.
 */
export class OllamaModelUnavailableError extends Error {
  readonly reason: "daemon-unreachable" | "pull-failed";
  readonly model: string;
  readonly status?: number;

  constructor(
    message: string,
    options: {
      reason: "daemon-unreachable" | "pull-failed";
      model: string;
      status?: number;
      cause?: unknown;
    }
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "OllamaModelUnavailableError";
    this.reason = options.reason;
    this.model = options.model;
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}

export async function ensureModelAvailable(
  model: string,
  providedBaseURL?: string,
  customFetch?: typeof fetch | null
): Promise<void> {
  const baseURL = providedBaseURL || "http://localhost:11434/api";
  const apiBase = baseURL.endsWith("/api") ? baseURL.slice(0, -4) : baseURL;
  const fetcher = customFetch ?? fetch;

  let showRes: Response;
  try {
    showRes = await fetcher(`${apiBase}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
  } catch (err) {
    // The Ollama daemon is unreachable (connection refused / DNS / timeout). This is NOT
    // "model absent" — we cannot even ask. Surface it so the caller reports the local
    // inference backend as down rather than proceeding into an inference call that will
    // fail with a less actionable error.
    throw new OllamaModelUnavailableError(
      `[Ollama] Cannot reach the Ollama daemon at ${apiBase} to verify model "${model}": ${
        err instanceof Error ? err.message : String(err)
      }`,
      { reason: "daemon-unreachable", model, cause: err }
    );
  }

  if (showRes.ok) {
    return;
  }

  logger.info(`[Ollama] Model ${model} not found locally. Downloading...`);

  let pullRes: Response;
  try {
    pullRes = await fetcher(`${apiBase}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false }),
    });
  } catch (err) {
    throw new OllamaModelUnavailableError(
      `[Ollama] Auto-download of model "${model}" failed to reach ${apiBase}/api/pull: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { reason: "pull-failed", model, cause: err }
    );
  }

  if (!pullRes.ok) {
    // The pull request was answered but the daemon could not fetch the model (unknown model
    // name, registry error, out-of-disk, ...). Do NOT continue: the model still is not present,
    // so the following generate/embed would fail anyway — fail here with the actionable reason.
    throw new OllamaModelUnavailableError(
      `[Ollama] Failed to pull model "${model}": HTTP ${pullRes.status} ${pullRes.statusText}`,
      { reason: "pull-failed", model, status: pullRes.status }
    );
  }

  logger.info(`[Ollama] Downloaded model ${model}`);
}
