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

import { fetchWithCsrf } from "../api/csrf-client";
import { resolveApiUrl } from "../utils";

export interface TranscribeWavOptions {
  /** Forwarded to `fetch` so callers can cancel an in-flight transcription. */
  signal?: AbortSignal;
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
 */
export async function transcribeCloudWav(
  audio: Uint8Array,
  options?: TranscribeWavOptions,
): Promise<string> {
  const res = await fetchWithCsrf(resolveApiUrl("/api/asr/cloud"), {
    method: "POST",
    headers: {
      "Content-Type": "audio/wav",
      Accept: "application/json",
    },
    // A Uint8Array is a valid BufferSource body; the cast bridges the DOM lib's
    // stricter `ArrayBuffer` generic on BodyInit (the runtime accepts it as-is).
    body: audio as BodyInit,
    signal: options?.signal,
  });
  if (!res.ok) {
    // error-policy:J6 best-effort error detail — the throw carries the status
    const body = await res.text().catch(() => "");
    throw new Error(`Cloud ASR ${res.status}: ${body.slice(0, 200)}`);
  }
  // error-policy:J3 unparseable body falls through to the empty-transcript throw
  const parsed = (await res.json().catch(() => null)) as {
    text?: unknown;
  } | null;
  const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
  if (!text) {
    throw new Error("Cloud ASR returned an empty transcript");
  }
  return text;
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
    // error-policy:J6 best-effort error detail — the throw carries the status
    const body = await res.text().catch(() => "");
    throw new Error(`Local inference ASR ${res.status}: ${body.slice(0, 200)}`);
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
