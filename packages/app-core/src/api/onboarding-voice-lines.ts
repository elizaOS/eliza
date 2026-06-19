/**
 * Canonical onboarding voice lines.
 *
 * Onboarding speaks before any agent (and any downloaded model) exists, so the
 * audio for these fixed lines is pre-generated once by our default OmniVoice
 * model and committed as bundled WAV presets (see
 * `scripts/voice-preset/build-onboarding-voice.mjs`). The first-run TTS route
 * serves those presets by `id`; the UI requests by step.
 *
 * The English `text` here is the source of truth for the generator. It must
 * stay in sync with the English defaults rendered in `FirstRunShell`
 * (`promptForStep`). Non-English locales display translated copy but keep the
 * English audio preset until localized presets are generated.
 */
export interface OnboardingVoiceLine {
  /** Stable id; also the preset filename stem (`<id>.wav`). */
  readonly id: string;
  /** Exact English text the preset audio speaks. */
  readonly text: string;
}

export const ONBOARDING_VOICE_LINES: readonly OnboardingVoiceLine[] = [
  { id: "runtime", text: "Where should Eliza run?" },
  { id: "remote", text: "Where is the remote agent?" },
];

const LINE_IDS: ReadonlySet<string> = new Set(
  ONBOARDING_VOICE_LINES.map((line) => line.id),
);

export function isOnboardingVoiceLineId(value: unknown): value is string {
  return typeof value === "string" && LINE_IDS.has(value);
}
