/**
 * Client probe for on-device Kokoro TTS readiness.
 *
 * The TTS default-resolver ({@link resolveDefaultTtsProvider}) prefers the
 * on-device `local-inference` Kokoro voice, but only when the runtime has a
 * TEXT_TO_SPEECH handler actually staged. This hits
 * `GET /api/tts/local-inference/status` (`{ ready, provider }`) — the mirror of
 * the ASR status probe — so a box with no local voice degrades to Eliza Cloud /
 * ElevenLabs / browser SpeechSynthesis instead of selecting `local-inference`
 * and 503-ing on the first utterance.
 *
 * Like the ASR probe, a failed/unreachable request deliberately resolves
 * `false`: "unknown readiness" is treated as "not ready" so a default is never
 * pinned to a backend we cannot confirm can synthesize.
 */

import { fetchWithCsrf } from "../api/csrf-client";
import { resolveApiUrl } from "../utils";

export async function isLocalInferenceTtsReady(options?: {
  signal?: AbortSignal;
}): Promise<boolean> {
  try {
    const res = await fetchWithCsrf(
      resolveApiUrl("/api/tts/local-inference/status"),
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
    // error-policy:J4 readiness probe — "unknown readiness" reads as "not
    // ready" (see header) so a default is never pinned to an unconfirmed engine
    return false;
  }
}
