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

export const VOICE_PREFIX_STEPS: readonly VoicePrefixStep[] = [
  "welcome",
  "tier",
  "models",
  "agent-speaks",
  "user-speaks",
  "owner-confirm",
  "family",
] as const;

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

export const VOICE_PREFIX_STEP_META: Record<
  VoicePrefixStep,
  VoicePrefixStepMeta
> = {
  welcome: {
    id: "welcome",
    nameKey: "onboarding.voice.welcome.name",
    defaultName: "Welcome",
    subtitleKey: "onboarding.voice.welcome.subtitle",
    defaultSubtitle: "Grant mic access and meet your agent.",
    optional: false,
  },
  tier: {
    id: "tier",
    nameKey: "onboarding.voice.tier.name",
    defaultName: "Device check",
    subtitleKey: "onboarding.voice.tier.subtitle",
    defaultSubtitle: "How your hardware will run voice.",
    optional: false,
  },
  models: {
    id: "models",
    nameKey: "onboarding.voice.models.name",
    defaultName: "Models",
    subtitleKey: "onboarding.voice.models.subtitle",
    defaultSubtitle: "Download voice models.",
    optional: true,
  },
  "agent-speaks": {
    id: "agent-speaks",
    nameKey: "onboarding.voice.agentspeaks.name",
    defaultName: "Listen",
    subtitleKey: "onboarding.voice.agentspeaks.subtitle",
    defaultSubtitle: "Hear the agent introduce itself.",
    optional: false,
  },
  "user-speaks": {
    id: "user-speaks",
    nameKey: "onboarding.voice.userspeaks.name",
    defaultName: "Speak",
    subtitleKey: "onboarding.voice.userspeaks.subtitle",
    defaultSubtitle: "Record three short prompts.",
    optional: false,
  },
  "owner-confirm": {
    id: "owner-confirm",
    nameKey: "onboarding.voice.ownerconfirm.name",
    defaultName: "Owner",
    subtitleKey: "onboarding.voice.ownerconfirm.subtitle",
    defaultSubtitle: "Confirm you are the owner.",
    optional: false,
  },
  family: {
    id: "family",
    nameKey: "onboarding.voice.family.name",
    defaultName: "Family",
    subtitleKey: "onboarding.voice.family.subtitle",
    defaultSubtitle: "Add other people the agent might hear (optional).",
    optional: true,
  },
};

/** Tier-aware step list — POOR tier skips the local model download. */
export function resolveVoicePrefixSteps(
  tier: "MAX" | "GOOD" | "OKAY" | "POOR" | null,
): readonly VoicePrefixStep[] {
  if (tier === "POOR") {
    return VOICE_PREFIX_STEPS.filter((s) => s !== "models");
  }
  return VOICE_PREFIX_STEPS;
}

export function nextVoicePrefixStep(
  current: VoicePrefixStep,
  tier: "MAX" | "GOOD" | "OKAY" | "POOR" | null,
): VoicePrefixStep | null {
  const steps = resolveVoicePrefixSteps(tier);
  const i = steps.indexOf(current);
  if (i < 0 || i >= steps.length - 1) return null;
  return steps[i + 1] ?? null;
}

export function previousVoicePrefixStep(
  current: VoicePrefixStep,
  tier: "MAX" | "GOOD" | "OKAY" | "POOR" | null,
): VoicePrefixStep | null {
  const steps = resolveVoicePrefixSteps(tier);
  const i = steps.indexOf(current);
  if (i > 0) return steps[i - 1] ?? null;
  return null;
}

export function voicePrefixIsComplete(
  current: VoicePrefixStep,
  tier: "MAX" | "GOOD" | "OKAY" | "POOR" | null,
): boolean {
  const steps = resolveVoicePrefixSteps(tier);
  return steps.indexOf(current) === steps.length - 1;
}
