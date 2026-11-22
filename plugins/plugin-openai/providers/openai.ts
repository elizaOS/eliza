/**
 * `createOpenAIClient`: builds the `@ai-sdk/openai` provider bound to the
 * runtime's resolved base URL and key. In proxy mode with no key it uses a
 * placeholder key (auth is injected upstream); otherwise a missing key throws.
 * The text handler creates one client per model call. Its closure correlates
 * SDK retries without recording payloads or changing transport ownership.
 */
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import {
  composeToolDiagnosticRedactor,
  ElizaError,
  fetchWithConfidentialInference,
  getInferenceTimer,
  getTrajectoryContext,
  type IAgentRuntime,
  type InferenceTimingMeta,
  logger,
} from "@elizaos/core";
import {
  applyCerebrasReasoningReplay,
  type CerebrasReasoningReplay,
} from "../utils/cerebras-reasoning";
import { getApiKey, getBaseURL, getSetting, isCerebrasMode } from "../utils/config";

/** Code of the error that ends an HTTP attempt its provider stopped answering. */
export const MODEL_ATTEMPT_IDLE_TIMEOUT = "MODEL_ATTEMPT_IDLE_TIMEOUT";

/**
 * How long a streamed direct-Cerebras attempt may wait for provider bytes: its
 * response headers, then each next body chunk. Without a bound a lost request
 * or connection waited for the caller's 180 s chat deadline, whose reply then
 * replaced the normal failure reply. Measured on qwen-3.8-27b (November 2026):
 * a streamed request gets its headers 0.15 to 0.4 s after it is sent, tool
 * calls included. The longest silence inside the body is a tool call, because
 * its whole arguments arrive in one chunk once generated (4,419 tokens after a
 * 2.5 s gap). That includes Stage 1 when the host streams it, and whether a
 * reasoning call streams its reasoning or stays silent through it was not
 * measured; the largest recorded Stage 1 reasoning, about 3,600 tokens, is
 * about 2 s at these rates. The model writes at most 40,960 tokens, about 25 s at the
 * measured streamed 1,600 to 1,800 tokens a second, so 60 s holds down to
 * about 680 tokens a second.
 *
 * A non-streamed request has no bound here. Its headers come only when
 * generation ends, so a limit on that wait is a limit on how much the model may
 * write, and output is not capped. The caller's signal bounds it (a chat turn's
 * 180 s deadline), and with no signal the HTTP client's own idle limit does
 * (Bun 1.4.2 gave up on a silent server after 360 s).
 */
const CEREBRAS_STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * The idle bound for this client's streamed attempts:
 * `OPENAI_ATTEMPT_IDLE_TIMEOUT_SECONDS` when it is a positive number, none when
 * it is 0, otherwise the Cerebras bound on the direct Cerebras route. Other
 * routes stay unbounded unless the host sets it: a reasoning model or a local
 * server can stream nothing for minutes on a sound call.
 */
function attemptIdleTimeoutMs(
  runtime: IAgentRuntime,
  endpoint: { provider: "openrouter" } | undefined
): number | undefined {
  const raw = getSetting(runtime, "OPENAI_ATTEMPT_IDLE_TIMEOUT_SECONDS");
  const seconds = raw?.trim() ? Number(raw) : Number.NaN;
  if (seconds === 0) return undefined;
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  return !endpoint && isCerebrasMode(runtime) ? CEREBRAS_STREAM_IDLE_TIMEOUT_MS : undefined;
}

/** True when a request body asks for a streamed response (`"stream": true`). */
function requestsStream(body: unknown): boolean {
  if (typeof body !== "string") return false;
  try {
    return (JSON.parse(body) as { stream?: unknown } | null)?.stream === true;
  } catch {
    // error-policy:J3 a body that is not JSON is not a streamed chat request; it stays unbounded.
    return false;
  }
}

/**
 * True for the error an idle attempt ends with, also as the cause the AI SDK
 * wraps a failed body read in. The text lanes never re-send it.
 */
export function isModelAttemptIdleTimeout(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    if ((current as { code?: unknown }).code === MODEL_ATTEMPT_IDLE_TIMEOUT) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Binds one streamed HTTP attempt to the caller's signal and to an idle bound:
 * every wait for provider bytes (the response headers, then each body read)
 * ends with a typed error after `idleMs`, and aborts the request so its socket
 * is released. A body read starts only when the consumer asks for the next
 * chunk, so time the consumer spends between reads is not counted.
 */
function boundAttempt(callerSignal: AbortSignal | null | undefined, idleMs: number) {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) controller.abort(callerSignal.reason);
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const release = () => callerSignal?.removeEventListener("abort", onCallerAbort);
  const wait = <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new ElizaError(
          `Model provider sent nothing for ${idleMs} ms; the HTTP attempt was abandoned`,
          { code: MODEL_ATTEMPT_IDLE_TIMEOUT }
        );
        controller.abort(error);
        reject(error);
      }, idleMs);
    });
    return Promise.race([work, idle]).finally(() => clearTimeout(timer));
  };
  const body = (response: Response): Response => {
    const source = response.body;
    if (!source) {
      release();
      return response;
    }
    const reader = source.getReader();
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            const next = await wait(reader.read());
            if (next.done) {
              release();
              stream.close();
            } else stream.enqueue(next.value);
          } catch (error) {
            // error-policy:J2 the caller's abort or the idle bound ends the body.
            release();
            stream.error(error);
          }
        },
        cancel(reason) {
          release();
          return reader.cancel(reason);
        },
      }),
      { status: response.status, statusText: response.statusText, headers: response.headers }
    );
  };
  return { signal: controller.signal, wait, body, release };
}

const SAFE_RESPONSE_HEADERS = [
  "x-request-id",
  "request-id",
  "retry-after",
  "retry-after-ms",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-tokens",
  "x-ratelimit-limit-requests-minute",
  "x-ratelimit-remaining-requests-minute",
  "x-ratelimit-reset-requests-minute",
  "x-ratelimit-limit-tokens-minute",
  "x-ratelimit-remaining-tokens-minute",
  "x-ratelimit-reset-tokens-minute",
  "x-ratelimit-limit-requests-day",
  "x-ratelimit-remaining-requests-day",
  "x-ratelimit-reset-requests-day",
  "x-ratelimit-limit-tokens-day",
  "x-ratelimit-remaining-tokens-day",
  "x-ratelimit-reset-tokens-day",
] as const;

function observeHttpDiagnostic<T>(observe: () => T): T | undefined {
  try {
    return observe();
  } catch {
    // error-policy:J7 optional diagnostics cannot replace transport results or
    // errors. Do not recurse into a failing log sink or expose diagnostic inputs.
    return undefined;
  }
}

export function createOpenAIClient(
  runtime: IAgentRuntime,
  endpoint?: { baseURL: string; apiKey: string; provider: "openrouter" },
  reasoningReplay?: CerebrasReasoningReplay,
  dispatchGuard?: {
    /** Captured by the trusted text caller; never model parameters. */
    baseURL: string;
    beforeDispatch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): void;
  }
): OpenAIProvider {
  const baseURL = dispatchGuard?.baseURL ?? endpoint?.baseURL ?? getBaseURL(runtime);
  const apiKey = endpoint?.apiKey ?? getApiKey(runtime);

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required. Set it in your environment variables or runtime settings."
    );
  }

  let httpAttempt = 0;
  const idleMs = attemptIdleTimeoutMs(runtime, endpoint);
  const diagnostic = observeHttpDiagnostic(() => {
    const callId = globalThis.crypto.randomUUID();
    const trajectory = getTrajectoryContext();
    const timer = getInferenceTimer();
    const redact = composeToolDiagnosticRedactor(runtime);
    const diagnosticText = (value: string): string => {
      // Bound diagnostic fields only; never retain a prefix of an untrusted value.
      if (value.length > 256) return "[OMITTED]";
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code < 32 || code === 127) return "[OMITTED]";
      }
      return redact(value);
    };
    const correlation: InferenceTimingMeta = {};
    for (const [key, value] of Object.entries({
      trajectoryId: trajectory?.trajectoryId,
      trajectoryStepId: trajectory?.trajectoryStepId,
      traceId: trajectory?.traceId,
      runId: trajectory?.runId,
      purpose: trajectory?.purpose,
      evaluatorName: trajectory?.evaluatorName,
      turnId: timer?.turnId,
      inferenceTraceId: timer?.traceId,
    })) {
      if (value !== undefined) correlation[key] = diagnosticText(value);
    }
    return { callId, timer, diagnosticText, correlation };
  });

  return createOpenAI({
    apiKey,
    baseURL,
    // Observe each actual HTTP attempt, including retries inside the AI SDK.
    // Model-call latency alone cannot distinguish retry waits from inference.
    // Never log request bodies, credentials, query strings, or response text.
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        // OpenRouter routes only to backends honoring the full tool/schema
        // contract. Its unified reasoning field differs from Cerebras's.
        if (endpoint?.provider === "openrouter" && typeof init?.body === "string") {
          const body = JSON.parse(init.body) as Record<string, unknown>;
          const reasoning = body.reasoning_effort;
          delete body.reasoning_effort;
          delete body.prompt_cache_retention;
          body.provider = {
            require_parameters: true,
            data_collection: "deny",
            sort: "latency",
          };
          if (typeof reasoning === "string") {
            body.reasoning = reasoning === "none" ? { enabled: false } : { effort: reasoning };
          }
          init = { ...init, body: JSON.stringify(body) };
        }
        if (reasoningReplay && typeof init?.body === "string") {
          const body = JSON.parse(init.body) as Record<string, unknown>;
          applyCerebrasReasoningReplay(body, reasoningReplay);
          init = { ...init, body: JSON.stringify(body) };
        }
        if (dispatchGuard) {
          // Rewrites above are complete. No await may separate this debit from
          // transport; redirects cannot leave the quoted provider route.
          dispatchGuard.beforeDispatch(input, init);
          init = { ...init, redirect: "error" };
        }
        const attempt = ++httpAttempt;
        const startedAt = Date.now();
        const startedMonotonic = performance.now();
        const observer = observeHttpDiagnostic(() => {
          if (!diagnostic) return undefined;
          const host = diagnostic.diagnosticText(new URL(baseURL).hostname);
          const fields = {
            ...diagnostic.correlation,
            callId: diagnostic.callId,
            attempt,
            attemptId: `${diagnostic.callId}:${attempt}`,
            host,
            startedAt,
          };
          const span: InferenceTimingMeta = { ...fields, phase: "started" };
          const closeSpan = observeHttpDiagnostic(() =>
            diagnostic.timer?.openSpan("openai.http", span)
          );
          observeHttpDiagnostic(() =>
            logger.debug(
              { ...fields, phase: "started" },
              `[OpenAI] HTTP attempt=${attempt} host=${host} started`
            )
          );
          return { fields, host, span, closeSpan };
        });
        const bound =
          idleMs !== undefined && requestsStream(init?.body)
            ? boundAttempt(init?.signal, idleMs)
            : undefined;
        if (bound) init = { ...init, signal: bound.signal };
        let response: Response;
        try {
          const sent = fetchWithConfidentialInference(input, init, globalThis.fetch);
          response = await (bound ? bound.wait(sent) : sent);
        } catch (error) {
          // error-policy:J2 transport owns the original rejection; observers are isolated.
          bound?.release();
          const endedAt = Date.now();
          const failedAfterMs = Math.round(performance.now() - startedMonotonic);
          observeHttpDiagnostic(() => {
            if (!observer) return;
            observer.span.phase = "error";
            observer.closeSpan?.();
          });
          observeHttpDiagnostic(() => {
            if (!observer) return;
            logger.warn(
              { ...observer.fields, phase: "error", endedAt, failedAfterMs },
              `[OpenAI] HTTP attempt=${attempt} host=${observer.host} failedAfterMs=${failedAfterMs}`
            );
          });
          throw error;
        }
        const endedAt = Date.now();
        const headersMs = Math.round(performance.now() - startedMonotonic);
        observeHttpDiagnostic(() => {
          if (!observer) return;
          observer.span.phase = "response";
          observer.span.status = response.status;
          observer.closeSpan?.();
        });
        observeHttpDiagnostic(() => {
          if (!observer || !diagnostic) return;
          const responseHeaders: Record<string, string> = {};
          for (const name of SAFE_RESPONSE_HEADERS) {
            const value = response.headers.get(name);
            if (value !== null) responseHeaders[name] = diagnostic.diagnosticText(value);
          }
          const retryAfterSeconds = Number(responseHeaders["retry-after"]);
          const retryAfter =
            Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
              ? ` retryAfterSeconds=${retryAfterSeconds}`
              : "";
          const message = `[OpenAI] HTTP attempt=${attempt} host=${observer.host} status=${response.status} headersMs=${headersMs}${retryAfter}`;
          const completed = {
            ...observer.fields,
            phase: "response",
            endedAt,
            status: response.status,
            headersMs,
            responseHeaders,
          };
          if (response.ok) logger.debug(completed, message);
          else logger.warn(completed, message);
        });
        return bound ? bound.body(response) : response;
      },
      { preconnect: globalThis.fetch.preconnect }
    ),
  });
}
