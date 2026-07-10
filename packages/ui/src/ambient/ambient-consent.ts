/**
 * Per-session ambient consent gate.
 *
 * AMBIENT-MODE-DESIGN §8.1: "Ambient capture requires an explicit per-session
 * consent action before the first uplink frame. No ambient session mints
 * without it." Consent is PER SESSION — it is not persisted across sessions and
 * is cleared whenever capture stops. Starting a new ambient session always
 * re-prompts. This module owns only that in-memory gate; it deliberately does
 * NOT write consent to storage (a "remembered consent" would defeat the
 * per-session requirement) and it NEVER records bystander consent (§8.3 — the
 * software cannot obtain it and must not claim to).
 */

/** Consent lifecycle for a single ambient session attempt. */
export type AmbientConsentState =
  | "ungranted" // no consent yet this session — capture is blocked
  | "granted"; // user explicitly consented for this session

/**
 * Jurisdiction-neutral two-party reminder shown at session start
 * (AMBIENT-MODE-DESIGN §8.3). Guidance, never a legal shield — it does not
 * geolocate or assert a specific law.
 */
export const AMBIENT_TWO_PARTY_REMINDER =
  "Recording laws vary by place. Some require everyone in the conversation to consent before you record. You are responsible for the people around you.";

/**
 * The consent copy the user affirms. Kept explicit so the gate cannot be
 * satisfied by an incidental click — the label states what starting does. The
 * processing-location clause is honest per path: the cloud/WS path streams
 * audio to a provider; the on-device batch path transcribes locally. Never
 * claim cloud for an on-device path or vice versa (AMBIENT-MODE-DESIGN §8.1).
 */
export function ambientConsentAffirmation(
  processingLocation: "on-device" | "cloud",
): string {
  const clause =
    processingLocation === "cloud"
      ? "and audio is streamed to the cloud for transcription"
      : "and audio is transcribed on this device";
  return `I understand this will continuously listen and transcribe until I pause or stop it, ${clause}.`;
}

/**
 * Backwards-compatible default affirmation string (cloud-worded). Prefer
 * {@link ambientConsentAffirmation} so the copy matches the actual path.
 */
export const AMBIENT_CONSENT_AFFIRMATION =
  ambientConsentAffirmation("cloud");

/** Reduce a consent action against the current consent state. */
export function ambientConsentReducer(
  state: AmbientConsentState,
  action: "grant" | "revoke",
): AmbientConsentState {
  return action === "grant" ? "granted" : "ungranted";
}

/** True when capture is permitted to begin. */
export function ambientCaptureAllowed(state: AmbientConsentState): boolean {
  return state === "granted";
}
