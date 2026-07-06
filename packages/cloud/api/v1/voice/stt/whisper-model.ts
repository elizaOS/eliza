/**
 * Resolves the model id sent to the self-hosted Whisper STT service for the
 * cloud `/api/v1/voice/stt` route. Split out from the route handler so the
 * deploy-config resolution is unit-testable without importing the route's heavy
 * billing/service graph.
 *
 * The default is English-only (`…-tiny.en`) for zero-config parity with the
 * historical hardcode; a deployment sets `WHISPER_STT_MODEL` to a multilingual
 * model (e.g. `Systran/faster-whisper-small`) to serve the non-English persona
 * corpus. The route already forwards the caller's `languageCode`, so a
 * multilingual model transcribes in the spoken language once configured.
 */

export const DEFAULT_WHISPER_STT_MODEL = "Systran/faster-whisper-tiny.en";

/** Returns the configured Whisper model, or the English-only default when the
 *  env var is unset/blank. Trims so a whitespace-only value degrades to default. */
export function resolveWhisperSttModel(configured: string | undefined): string {
  const trimmed = configured?.trim();
  return trimmed ? trimmed : DEFAULT_WHISPER_STT_MODEL;
}
