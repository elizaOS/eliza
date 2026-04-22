/**
 * Detects failures that usually mean a **hot-plugged** local inference server
 * (LM Studio, Ollama, vLLM) went away or has no model loaded in-app, so the
 * router should invalidate cached hub probes and try another registered handler.
 */

function appendCauseChain(err: unknown, parts: string[]): void {
  let c: unknown = err instanceof Error ? err.cause : undefined;
  let depth = 0;
  while (c instanceof Error && depth++ < 6) {
    parts.push(c.message);
    c = c.cause;
  }
}

export function collectErrorText(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
    appendCauseChain(err, parts);
  }
  const rec = err as Record<string, unknown>;
  if (typeof rec.responseBody === "string") parts.push(rec.responseBody);
  if (typeof rec.bodyText === "string") parts.push(rec.bodyText);
  const data = rec.data;
  if (data && typeof data === "object") {
    const msg = (data as { error?: { message?: string } }).error?.message;
    if (typeof msg === "string") parts.push(msg);
  }
  return parts.join("\n");
}

/**
 * True when the error looks like a **transport or local-server lifecycle** issue
 * (LM Studio quit, nothing loaded in the UI, connection refused), not e.g. a
 * normal OpenAI 401 from bad credentials.
 */
export function errorsSuggestsHotpluggedBackendGone(err: unknown): boolean {
  const t = collectErrorText(err).toLowerCase();
  if (
    /econnrefused|enotfound|econnreset|socket hang up|networkerror|fetch failed|timed out|timeout|etimedout|eai_again/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/no models loaded|please load a model|lms load|developer page/i.test(t)) {
    return true;
  }
  if (/connection refused|server closed|socket closed|broken pipe/i.test(t)) {
    return true;
  }
  const rec = err as Record<string, unknown>;
  const status = Number(rec.statusCode ?? rec.status ?? 0);
  if (status === 502 || status === 503 || status === 504) return true;
  if (
    status === 400 &&
    /no models loaded|please load a model|lms load/i.test(t)
  ) {
    return true;
  }
  return false;
}

function isSelfHostedOpenAiCompatBaseUrl(): boolean {
  const base = (process.env.OPENAI_BASE_URL ?? "").toLowerCase().trim();
  return Boolean(base && !base.includes("api.openai.com"));
}

/**
 * Whether the router should **exclude this provider and try another** after a
 * failure (LM Studio quit mid-stream, Ollama socket dead, etc.).
 */
export function shouldAttemptHotplugRetry(
  provider: string,
  err: unknown,
): boolean {
  if (errorsSuggestsHotpluggedBackendGone(err)) return true;
  if (provider !== "openai" || !isSelfHostedOpenAiCompatBaseUrl()) return false;
  const t = collectErrorText(err).toLowerCase();
  // AI SDK often surfaces LM Studio death as stream flush errors without the
  // original 400 body on the outer error.
  return /no output generated|check the stream for errors/i.test(t);
}

/**
 * When true, clear the external LLM hub cache so the next `routerInferenceReady`
 * reflects reality (LM Studio closed, Ollama stopped, etc.).
 */
export function shouldInvalidateExternalProbeCache(
  provider: string,
  err: unknown,
): boolean {
  if (!shouldAttemptHotplugRetry(provider, err)) return false;
  if (provider === "ollama") return true;
  if (provider === "openai") return isSelfHostedOpenAiCompatBaseUrl();
  return false;
}
