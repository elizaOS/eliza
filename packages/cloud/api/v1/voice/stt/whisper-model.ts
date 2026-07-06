/**
 * Resolves the model id sent to the self-hosted Whisper STT service for the
 * cloud `/api/v1/voice/stt` route. Split out from the route handler so the
 * deploy-config resolution is unit-testable without importing the route's heavy
 * billing/service graph.
 *
 * The default is multilingual (`…-small`) because the route already forwards the
 * caller's `languageCode` and the MVP persona corpus includes non-English
 * speakers. Deployments can still set `WHISPER_STT_MODEL` to pin another hosted
 * model without introducing a per-request override.
 */

export const DEFAULT_WHISPER_STT_MODEL = "Systran/faster-whisper-small";

/** Returns the configured Whisper model, or the multilingual default when the
 *  env var is unset/blank. Trims so a whitespace-only value degrades to default. */
export function resolveWhisperSttModel(configured: string | undefined): string {
  const trimmed = configured?.trim();
  return trimmed ? trimmed : DEFAULT_WHISPER_STT_MODEL;
}
