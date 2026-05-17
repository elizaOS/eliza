/**
 * VoiceSection — top-level Settings → Voice tree (R10 §8).
 *
 * Mounts six sub-panels into a single scrollable section:
 *
 * 1. Device tier banner (R10 §7, banner pulled in from VoiceTierBanner).
 * 2. Continuous chat mode (off / vad-gated / always-on).
 * 3. Wake word — placeholder until WakeWordSection is decoupled from
 *    VoiceConfigView.
 * 4. Local-vs-Cloud strategy (auto / force-local / force-cloud).
 * 5. Models — slot for I5's ModelUpdatesPanel (renders the slot prop or
 *    an empty banner if I5 hasn't landed).
 * 6. Profiles — VoiceProfileSection.
 * 7. Privacy — first-line cache opt-in + auto-learn toggle.
 *
 * The section is intentionally additive — it does not modify the existing
 * `IdentitySettingsSection`'s embedded `VoiceConfigView`. R10 §8.2: legacy
 * `messages.tts.*` keys stay; the new `messages.voice.*` keys live here.
 */
import * as React from "react";
import type { VoiceProfilesClient } from "../../api/client-voice-profiles";
import { type VoiceContinuousMode } from "../../voice/voice-chat-types";
import { type VoiceDeviceTier } from "./VoiceTierBanner";
export type VoiceLocalCloudStrategy = "auto" | "force-local" | "force-cloud";
export interface VoiceSectionPrefs {
  continuous: VoiceContinuousMode;
  strategy: VoiceLocalCloudStrategy;
  cloudFirstLineCache: boolean;
  autoLearnVoices: boolean;
}
export declare const DEFAULT_VOICE_SECTION_PREFS: VoiceSectionPrefs;
export interface VoiceSectionProps {
  /** Hardware tier from I9 (null falls back to "GOOD"). */
  tier: VoiceDeviceTier | null;
  /** Optional summary line for the tier banner. */
  tierSummary?: string;
  /** Current preferences (caller maintains state and persists). */
  prefs: VoiceSectionPrefs;
  /** Persist updated preferences. */
  onPrefsChange: (next: VoiceSectionPrefs) => void;
  /** Adapter to I2 voice-profile endpoints. */
  profilesClient: VoiceProfilesClient;
  /**
   * Slot for I5's ModelUpdatesPanel — caller mounts it when ready, otherwise
   * we render a "Models will appear here once they finish downloading"
   * placeholder.
   */
  modelsPanel?: React.ReactNode;
  /** Whether the user has at least one wake-word configured. */
  wakeWordEnabled?: boolean;
  /** Toggle wake-word listening (caller wires Swabble). */
  onWakeWordToggle?: (next: boolean) => void;
  className?: string;
}
export declare function VoiceSection({
  tier,
  tierSummary,
  prefs,
  onPrefsChange,
  profilesClient,
  modelsPanel,
  wakeWordEnabled,
  onWakeWordToggle,
  className,
}: VoiceSectionProps): React.ReactElement;
export default VoiceSection;
//# sourceMappingURL=VoiceSection.d.ts.map
