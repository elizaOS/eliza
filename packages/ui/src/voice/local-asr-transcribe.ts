/**
 * Shared client for `POST /api/asr/local-inference`.
 *
 * Used by both {@link createVoiceCapture} (the hook-free factory that powers
 * the desktop voice pill) and `useVoiceChat` (the chat composer hook). Both
 * callers POST an identical WAV body and parse an identical `{ text }`
 * response, so the round-trip lives here.
 *
 * The helper throws on non-2xx responses and on empty transcripts; both
 * call-sites already treat those as errors today. Caller-specific error
 * recovery (the factory re-throws after surfacing via `onStateChange`; the
 * hook swallows + cleans up state) stays at the call-site.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { getCloudAuthToken } from "../api/client-cloud";
import { fetchWithCsrf, requestViaAgentTransport } from "../api/csrf-client";
import { resolveApiUrl } from "../utils";
import {
  buildSharedRuntimeSttBody,
  configuredCloudVoiceOrigin,
  currentSharedRuntimeVoiceOrigin,
  parseSharedRuntimeSttResponse,
  sharedRuntimeSttUrl,
} from "./shared-runtime-voice";

export interface TranscribeWavOptions {
  /** Forwarded to `fetch` so callers can cancel an in-flight transcription. */
  signal?: AbortSignal;
}

/** Default per-attempt client-side STT timeout (#voice-V4). */
export const DEFAULT_CLOUD_STT_TIMEOUT_MS = 15_000;

export interface TranscribeCloudWavOptions extends TranscribeWavOptions {
  /** Cloud Worker origin used to bypass a dedicated container proxy. */
  configuredCloudOrigin?: string | null;
  /** Cloud session bearer for the direct Worker request. */
  cloudSessionToken?: string | null;
  /**
   * Per-attempt client-side timeout (#voice-V4). A flaky-cellular POST that
   * never resolves would otherwise hang the turn in "processing" forever
   * (fetch has no default timeout). Each attempt gets its own AbortController
   * armed to this deadline; on a network-class failure the helper retries ONCE
   * before surfacing the error. Defaults to {@link DEFAULT_CLOUD_STT_TIMEOUT_MS}.
   */
  timeoutMs?: number;
}

/**
 * Error thrown by {@link transcribeCloudWav} carrying the HTTP status (when the
 * failure was an HTTP response) so callers / the retry logic can distinguish a
 * retryable transport hiccup (timeout, 5xx, 429) from a terminal client error
 * (401/402/413 — retrying won't help).
 */
export class CloudSttError extends Error {
  /** HTTP status when the failure was a response; `undefined` for transport/timeout. */
  readonly status?: number;
  /** Machine-readable server error code when the response provides one. */
  readonly code?: string;
  /** True when this failure class is safe to retry once (network/timeout/5xx/429). */
  readonly retryable: boolean;
  constructor(
    message: string,
    opts: {
      status?: number;
      code?: string;
      retryable: boolean;
      cause?: unknown;
    },
  ) {
    super(
      message,
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "CloudSttError";
    this.status = opts.status;
    this.code = opts.code;
    this.retryable = opts.retryable;
  }
}

const CLOUD_STT_STARTING_RETRY_LIMIT = 30;
const CLOUD_STT_STARTING_RETRY_DELAY_MS = 1_000;

/**
 * Whether a Cloud STT failure is a self-healing warmup the client should wait
 * out with the patient 1s×30 retry loop rather than the single transient
 * retry. Two server shapes qualify: a dedicated runtime's `feature_starting`
 * (deferred route registration) and the shared worker's warming 503
 * (`service_unavailable` — "Authorization cache is warming; retry shortly",
 * observed clearing within a few seconds). A single retry loses a real
 * utterance to a warmup that would have succeeded moments later, which
 * violates the hold-to-talk contract that a spoken turn must not silently
 * vanish (#20483).
 */
function isCloudSttWarmup(err: CloudSttError): boolean {
  return (
    err.code === "feature_starting" ||
    (err.status === 503 && err.code === "service_unavailable")
  );
}

function readCloudSttErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: unknown };
    if (typeof parsed.code === "string") return parsed.code;
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    // error-policy:J3 an unparseable diagnostic body has no machine-readable
    // code; status-based retry classification remains authoritative.
    return undefined;
  }
}

async function waitForCloudSttStartup(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new CloudSttError("Cloud ASR request was cancelled", {
      retryable: false,
    });
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new CloudSttError("Cloud ASR request was cancelled", {
          retryable: false,
        }),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, CLOUD_STT_STARTING_RETRY_DELAY_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** HTTP statuses worth one automatic retry (transient upstream/transport). */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export interface TranscribeWavResult {
  /** Trimmed transcript text. Never empty — the helper throws instead. */
  text: string;
  /** Per-word timings (ms from this utterance's start) when the fused ASR
   *  build (ABI v12+) emits them; empty otherwise (segment-level highlight). */
  words: ReadonlyArray<{ text: string; startMs: number; endMs: number }>;
}

/** Validate the `words` array shape from the ASR response (drop malformed). */
function parseWords(
  value: unknown,
): ReadonlyArray<{ text: string; startMs: number; endMs: number }> {
  if (!Array.isArray(value)) return [];
  const out: { text: string; startMs: number; endMs: number }[] = [];
  for (const w of value) {
    if (
      w &&
      typeof w === "object" &&
      typeof (w as { text?: unknown }).text === "string" &&
      typeof (w as { startMs?: unknown }).startMs === "number" &&
      typeof (w as { endMs?: unknown }).endMs === "number"
    ) {
      const word = w as { text: string; startMs: number; endMs: number };
      out.push({ text: word.text, startMs: word.startMs, endMs: word.endMs });
    }
  }
  return out;
}

/**
 * Probe whether the server can fulfill local-inference ASR right now via
 * `GET /api/asr/local-inference/status` (`{ ready, provider }`).
 *
 * Capture surfaces use this to choose a backend that can actually transcribe:
 * routing audio to `/api/asr/local-inference` when the server has no local ASR
 * assets / native adapter 502s at `stop()` with no recoverable fallback, so an
 * unready (or unreachable) server must degrade to browser ASR instead. A
 * failed probe deliberately resolves `false` — "unknown readiness" is treated
 * as "not ready" so we never capture audio we can't transcribe.
 */
export async function isLocalInferenceAsrReady(
  options?: TranscribeWavOptions,
): Promise<boolean> {
  try {
    const res = await fetchWithCsrf(
      resolveApiUrl("/api/asr/local-inference/status"),
      {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: options?.signal,
      },
    );
    if (!res.ok) return false;
    // error-policy:J3 non-JSON body reads as "not ready"
    const parsed = (await res.json().catch(() => null)) as {
      ready?: unknown;
    } | null;
    return parsed?.ready === true;
  } catch {
    // error-policy:J4 readiness probe — "unknown readiness" deliberately reads
    // as "not ready" (see header) so we never capture untranscribable audio
    return false;
  }
}

/** Base64-encode bytes in chunks (avoids the apply() arg-count limit on big WAVs). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/**
 * POST a captured WAV to the agent's cloud STT proxy (`POST /api/asr/cloud`),
 * which forwards it to Eliza Cloud's `/voice/stt` route and returns `{ text }`.
 *
 * This is the cloud counterpart to {@link transcribeLocalInferenceWav}: the
 * interactive `eliza-cloud` capture path records the same mono PCM16 WAV and
 * routes it here so web STT is the deterministic cloud transcriber instead of
 * the engine-dependent browser recognizer. The WAV is sent as raw bytes (the
 * proxy reads the raw body and re-wraps it as multipart for the cloud); no
 * per-word timings are returned by the cloud route, so this yields text only.
 *
 * Fails loud: a non-2xx response or an empty transcript throws, so the capture
 * surface renders an error state rather than silently substituting browser STT.
 *
 * Resilient (#voice-V4): each attempt is bounded by a client-side timeout
 * (`timeoutMs`, default 15s) and a single automatic retry covers a network-class
 * failure (transport error, timeout, 5xx, 429) so a flaky-cellular STT doesn't
 * hard-fail the turn on the first hiccup. Terminal client errors (401/402/413)
 * and an empty transcript are NOT retried — retrying won't change the outcome.
 * A dedicated runtime's explicit `feature_starting` response gets its own
 * bounded 30-second readiness window so an immediate post-launch mic tap waits
 * for deferred route registration instead of firing two back-to-back failures.
 * A caller-initiated abort (`options.signal`) is honored immediately and never
 * retried.
 */
export async function transcribeCloudWav(
  audio: Uint8Array,
  options?: TranscribeCloudWavOptions,
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CLOUD_STT_TIMEOUT_MS;
  const callerSignal = options?.signal;

  // One attempt: arm a per-attempt timeout AbortController, compose it with the
  // caller's signal, POST, and classify any failure as retryable or terminal.
  const attempt = async (): Promise<string> => {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timeoutController.abort();
    }, timeoutMs);
    // Chain the caller's abort into this attempt so an outer cancel still
    // aborts the in-flight fetch (and is distinguishable from a timeout below).
    const onCallerAbort = () => timeoutController.abort();
    if (callerSignal) {
      if (callerSignal.aborted) timeoutController.abort();
      else
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    try {
      // Shared-tier fallback (#15395): a shared-runtime agent has no
      // `/api/asr/cloud` container route (404s), so target the cloud API
      // worker's provider-agnostic v1 STT route instead — multipart `audio`
      // File in, `{ transcript }` out. A cloud-authenticated dedicated session
      // also bypasses the container proxy and calls that Worker route directly;
      // local/remote dedicated agents without cloud auth keep the raw-WAV proxy.
      const sharedOrigin = currentSharedRuntimeVoiceOrigin();
      const directOrigin = (
        options?.configuredCloudOrigin ?? configuredCloudVoiceOrigin()
      )?.replace(/\/+$/, "");
      const cloudToken = (
        options?.cloudSessionToken ?? getCloudAuthToken()
      )?.trim();
      const directRoute =
        !sharedOrigin && directOrigin && cloudToken
          ? { origin: directOrigin, token: cloudToken }
          : null;
      const workerOrigin = sharedOrigin ?? directRoute?.origin ?? null;
      const workerRequest: RequestInit = {
        method: "POST",
        // No explicit Content-Type: the browser sets the multipart boundary.
        headers: {
          Accept: "application/json",
          ...(directRoute
            ? { Authorization: `Bearer ${directRoute.token}` }
            : {}),
        },
        body: buildSharedRuntimeSttBody(audio),
        signal: timeoutController.signal,
      };
      const fetchDedicatedProxy = () =>
        fetchWithCsrf(resolveApiUrl("/api/asr/cloud"), {
          method: "POST",
          headers: {
            "Content-Type": "audio/wav",
            Accept: "application/json",
          },
          // A Uint8Array is a valid BufferSource body; the cast bridges the
          // DOM lib's stricter `ArrayBuffer` generic on BodyInit (runtime
          // accepts it).
          body: audio as BodyInit,
          signal: timeoutController.signal,
        });

      let usedWorkerRoute = Boolean(workerOrigin);
      let res: Response;
      if (directRoute) {
        try {
          res = await requestViaAgentTransport(
            sharedRuntimeSttUrl(directRoute.origin),
            workerRequest,
          );
          if (res.status === 401 || res.status === 403) {
            res = await fetchDedicatedProxy();
            usedWorkerRoute = false;
          }
        } catch (error) {
          if (timeoutController.signal.aborted) throw error;
          res = await fetchDedicatedProxy();
          usedWorkerRoute = false;
        }
      } else if (workerOrigin) {
        res = await fetchWithCsrf(
          sharedRuntimeSttUrl(workerOrigin),
          workerRequest,
        );
      } else {
        res = await fetchDedicatedProxy();
      }
      if (!res.ok) {
        // error-policy:J6 the error body is diagnostic-only; a failed read must
        // not mask the HTTP status the error below already carries.
        const body = await res.text().catch(() => "");
        throw new CloudSttError(
          `Cloud ASR ${res.status}: ${truncateWellFormed(toWellFormedUnicode(body), 200)}`,
          {
            status: res.status,
            code: readCloudSttErrorCode(body),
            retryable: isRetryableStatus(res.status),
          },
        );
      }
      // error-policy:J3 unparseable body falls through to the empty-transcript
      // throw (terminal — a bad body won't parse on a retry either). The v1
      // shared route returns `{ transcript }`; the dedicated proxy returns
      // `{ text }` — both are handled (shared via parseSharedRuntimeSttResponse,
      // dedicated via the `text` read).
      const parsed = (await res.json().catch(() => null)) as {
        text?: unknown;
        transcript?: unknown;
      } | null;
      const text = usedWorkerRoute
        ? parseSharedRuntimeSttResponse(parsed)
        : typeof parsed?.text === "string"
          ? parsed.text.trim()
          : "";
      if (!text) {
        throw new CloudSttError("Cloud ASR returned an empty transcript", {
          retryable: false,
        });
      }
      return text;
    } catch (err) {
      if (err instanceof CloudSttError) throw err;
      // A caller-initiated abort is terminal + must surface as the caller's
      // cancel, not a timeout retry.
      if (callerSignal?.aborted) {
        throw new CloudSttError("Cloud ASR request was cancelled", {
          retryable: false,
          cause: err,
        });
      }
      // Our own timeout fired — retryable transport-class failure.
      if (timeoutController.signal.aborted) {
        throw new CloudSttError(`Cloud ASR timed out after ${timeoutMs}ms`, {
          retryable: true,
          cause: err,
        });
      }
      // Any other throw (fetch TypeError = DNS/offline/connection reset) is a
      // network-class failure — retry once.
      throw new CloudSttError(
        `Cloud ASR request failed: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: true, cause: err },
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  };

  let transientRetries = 0;
  let startingRetries = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof CloudSttError)) throw err;
      if (callerSignal?.aborted) {
        throw new CloudSttError("Cloud ASR request was cancelled", {
          retryable: false,
          cause: err,
        });
      }
      if (isCloudSttWarmup(err)) {
        if (startingRetries >= CLOUD_STT_STARTING_RETRY_LIMIT) throw err;
        startingRetries++;
        await waitForCloudSttStartup(callerSignal);
        continue;
      }
      // One auto-retry on an ordinary network-class failure.
      if (err.retryable && transientRetries < 1) {
        transientRetries++;
        continue;
      }
      throw err;
    }
  }
}

export async function transcribeLocalInferenceWav(
  audio: Uint8Array,
  options?: TranscribeWavOptions,
): Promise<TranscribeWavResult> {
  // Send the audio as base64 JSON (a STRING body), not a raw binary body: the
  // Android local-agent IPC only forwards string request bodies, so a binary
  // POST 503s with "only supports string request bodies". The ASR route accepts
  // `{ audioBase64 }` on every platform (web/desktop decode it identically).
  const res = await fetchWithCsrf(resolveApiUrl("/api/asr/local-inference"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ audioBase64: bytesToBase64(audio) }),
    signal: options?.signal,
  });
  if (!res.ok) {
    // error-policy:J6 the error body is diagnostic-only; a failed read must not
    // mask the real signal (the HTTP status the throw below already carries).
    const body = await res.text().catch(() => "");
    throw new Error(
      `Local inference ASR ${res.status}: ${truncateWellFormed(toWellFormedUnicode(body), 200)}`,
    );
  }
  // error-policy:J3 unparseable body falls through to the explicit
  // empty-transcript throw below
  const parsed = (await res.json().catch(() => null)) as {
    text?: unknown;
    words?: unknown;
  } | null;
  const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
  if (!text) {
    throw new Error("Local inference ASR returned an empty transcript");
  }
  return { text, words: parseWords(parsed?.words) };
}
