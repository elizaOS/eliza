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
}

/**
 * Probe whether the server can fulfill local-inference ASR right now via
 * `GET /api/asr/local-inference/status` (`{ ready, provider }`).
 *
 * Capture surfaces use this to choose a backend that can actually transcribe:
 * routing audio to `/api/asr/local-inference` when the server has no whisper
 * model / native adapter 502s at `stop()` with no recoverable fallback, so an
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
    const parsed = (await res.json().catch(() => null)) as {
      ready?: unknown;
    } | null;
    return parsed?.ready === true;
  } catch {
    return false;
  }
}

export async function transcribeLocalInferenceWav(
  audio: Uint8Array,
  options?: TranscribeWavOptions,
): Promise<TranscribeWavResult> {
  const audioBody = new ArrayBuffer(audio.byteLength);
  new Uint8Array(audioBody).set(audio);
  const res = await fetchWithCsrf(resolveApiUrl("/api/asr/local-inference"), {
    method: "POST",
    headers: {
      "Content-Type": "audio/wav",
      Accept: "application/json",
    },
    body: audioBody,
    signal: options?.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Local inference ASR ${res.status}: ${body.slice(0, 200)}`);
  }
  const parsed = (await res.json().catch(() => null)) as {
    text?: unknown;
  } | null;
  const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
  if (!text) {
    throw new Error("Local inference ASR returned an empty transcript");
  }
  return { text };
}
