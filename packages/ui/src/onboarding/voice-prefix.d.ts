/**
 * Voice onboarding prefix (R10 §3).
 *
 * The existing 3-step graph (`deployment → providers → features`) is the
 * **post-voice** flow. The voice prefix runs before it for fresh installs
 * where the user wants to set up speaker-id + OWNER role + voice models.
 *
 * Why separate from `flow.ts`:
 * - Avoid expanding `OnboardingStep` and the 2442-LOC AppContext switch.
 *   The existing tests / shell / sidebar all read `OnboardingStep` and
 *   would need parallel changes — high risk for the existing wizard.
 * - Voice onboarding has its own concerns (mic permission, capture,
 *   downloads, tier branch) that don't share state with provider /
 *   features steps.
 *
 * The prefix runs as a self-contained sub-flow rendered by the onboarding
 * shell when `voicePrefixEnabled` is true. When complete it hands off to
 * the legacy 3-step flow.
 */
export type VoicePrefixStep =
  | "welcome"
  | "tier"
  | "models"
  | "agent-speaks"
  | "user-speaks"
  | "owner-confirm"
  | "family";
export declare const VOICE_PREFIX_STEPS: readonly VoicePrefixStep[];
export interface VoicePrefixStepMeta {
  id: VoicePrefixStep;
  /** i18n key for the human-readable step name. */
  nameKey: string;
  /** Fallback English label rendered when i18n misses the key. */
  defaultName: string;
  /** Subtitle key. */
  subtitleKey: string;
  /** Fallback English subtitle. */
  defaultSubtitle: string;
  /** Whether the user can skip this step. */
  optional: boolean;
}
export declare const VOICE_PREFIX_STEP_META: Record<
  VoicePrefixStep,
  VoicePrefixStepMeta
>;
/** Tier-aware step list — POOR tier skips the local model download. */
export declare function resolveVoicePrefixSteps(
  tier: "MAX" | "GOOD" | "OKAY" | "POOR" | null,
): readonly VoicePrefixStep[];
export declare function nextVoicePrefixStep(
  current: VoicePrefixStep,
  tier: "MAX" | "GOOD" | "OKAY" | "POOR" | null,
): VoicePrefixStep | null;
export declare function previousVoicePrefixStep(
  current: VoicePrefixStep,
  tier: "MAX" | "GOOD" | "OKAY" | "POOR" | null,
): VoicePrefixStep | null;
export declare function voicePrefixIsComplete(
  current: VoicePrefixStep,
  tier: "MAX" | "GOOD" | "OKAY" | "POOR" | null,
): boolean;
//# sourceMappingURL=voice-prefix.d.ts.map
