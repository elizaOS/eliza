/**
 * Ensures a requested Ollama model exists before inference, pulling it once
 * when the daemon reports it missing and surfacing every transport failure.
 */
import { ElizaError, logger, toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";

async function responseDetail(response: Response): Promise<string> {
  try {
    const body = (await response.text()).trim();
    return body.length > 0
      ? truncateWellFormed(toWellFormedUnicode(body), 500)
      : response.statusText;
  } catch (error) {
    // error-policy:J4 the HTTP status remains authoritative; preserve an
    // explicit unavailable marker instead of disguising the missing body.
    return `response body unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function ensureModelAvailable(
  model: string,
  providedBaseURL?: string,
  customFetch?: typeof fetch | null,
  signal?: AbortSignal
): Promise<void> {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    throw new ElizaError("Ollama model name is required", {
      code: "OLLAMA_MODEL_NAME_REQUIRED",
      severity: "fatal",
    });
  }

  const baseURL = (providedBaseURL || "http://localhost:11434/api").replace(/\/+$/, "");
  const apiBase = baseURL.endsWith("/api") ? baseURL.slice(0, -4) : baseURL;
  const fetcher = customFetch ?? fetch;

  try {
    const showResponse = await fetcher(`${apiBase}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: normalizedModel }),
      signal,
    });
    if (showResponse.ok) return;

    const showDetail = await responseDetail(showResponse);
    if (showResponse.status !== 404 && showResponse.status !== 400) {
      throw new ElizaError(`Ollama model lookup failed: ${showDetail}`, {
        code: "OLLAMA_MODEL_LOOKUP_FAILED",
        context: { model: normalizedModel, status: showResponse.status, apiBase },
        severity: "ephemeral",
      });
    }

    logger.info(`[Ollama] Model ${normalizedModel} is missing; pulling it now`);
    const pullResponse = await fetcher(`${apiBase}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: normalizedModel, stream: false }),
      signal,
    });
    if (!pullResponse.ok) {
      const pullDetail = await responseDetail(pullResponse);
      throw new ElizaError(`Ollama failed to pull ${normalizedModel}: ${pullDetail}`, {
        code: "OLLAMA_MODEL_PULL_FAILED",
        context: { model: normalizedModel, status: pullResponse.status, apiBase },
        severity: "ephemeral",
      });
    }
    logger.info(`[Ollama] Pulled model ${normalizedModel}`);
  } catch (error) {
    // error-policy:J2 model readiness is required by the caller; add endpoint
    // and model context while preserving the original transport failure.
    if (error instanceof ElizaError) throw error;
    throw new ElizaError(`Unable to prepare Ollama model ${normalizedModel}`, {
      code: "OLLAMA_MODEL_PREPARE_FAILED",
      cause: error,
      context: { model: normalizedModel, apiBase },
      severity: "ephemeral",
    });
  }
}
