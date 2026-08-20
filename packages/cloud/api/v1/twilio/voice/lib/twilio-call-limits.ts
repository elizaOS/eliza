/** Keeps Twilio webhook directory retention aligned with media-session duration. */

const DEFAULT_MAX_CALL_SECONDS = 30 * 60;
const MAX_CALL_SECONDS = 24 * 60 * 60;

export function resolveTwilioMaxCallSeconds(env: unknown): number {
  const value = Number(
    (env as { TWILIO_VOICE_MAX_CALL_SECONDS?: string })
      .TWILIO_VOICE_MAX_CALL_SECONDS,
  );
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), MAX_CALL_SECONDS)
    : DEFAULT_MAX_CALL_SECONDS;
}

/** Preserve revocation lookup through a call that starts at bootstrap expiry. */
export function resolveTwilioSessionDirectoryExpSeconds(
  bootstrapExpSeconds: number,
  env: unknown,
): number {
  return bootstrapExpSeconds + resolveTwilioMaxCallSeconds(env);
}
