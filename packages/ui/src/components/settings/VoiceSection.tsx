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

// biome-ignore lint/correctness/noUnusedImports: required for JSX transform.
import * as React from "react";
import { Cloud, Database, Mic, Shield, Sliders } from "lucide-react";

import { cn } from "../../lib/utils";
import { ContinuousChatToggle } from "../composites/chat/ContinuousChatToggle";
import {
  DEFAULT_VOICE_CONTINUOUS_MODE,
  type VoiceContinuousMode,
} from "../../voice/voice-chat-types";
import { VoiceTierBanner, type VoiceDeviceTier } from "./VoiceTierBanner";
import { VoiceProfileSection } from "./VoiceProfileSection";
import type { VoiceProfilesClient } from "../../api/client-voice-profiles";

export type VoiceLocalCloudStrategy = "auto" | "force-local" | "force-cloud";

export interface VoiceSectionPrefs {
  continuous: VoiceContinuousMode;
  strategy: VoiceLocalCloudStrategy;
  cloudFirstLineCache: boolean;
  autoLearnVoices: boolean;
}

export const DEFAULT_VOICE_SECTION_PREFS: VoiceSectionPrefs = {
  continuous: DEFAULT_VOICE_CONTINUOUS_MODE,
  strategy: "auto",
  cloudFirstLineCache: false,
  autoLearnVoices: true,
};

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

function FieldRow({
  icon: Icon,
  title,
  description,
  children,
  "data-testid": dataTestId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  children: React.ReactNode;
  "data-testid"?: string;
}): React.ReactElement {
  return (
    <div
      className="flex items-start justify-between gap-3 rounded-lg border border-border/30 bg-card/30 p-3"
      data-testid={dataTestId}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
        <div>
          <div className="text-sm font-semibold">{title}</div>
          {description ? (
            <div className="mt-0.5 text-xs text-muted">{description}</div>
          ) : null}
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function VoiceSection({
  tier,
  tierSummary,
  prefs,
  onPrefsChange,
  profilesClient,
  modelsPanel,
  wakeWordEnabled = false,
  onWakeWordToggle,
  className,
}: VoiceSectionProps): React.ReactElement {
  const updatePrefs = React.useCallback(
    (patch: Partial<VoiceSectionPrefs>) => {
      onPrefsChange({ ...prefs, ...patch });
    },
    [onPrefsChange, prefs],
  );

  return (
    <section
      data-testid="voice-section"
      className={cn("flex flex-col gap-4 p-4 sm:p-5", className)}
    >
      <VoiceTierBanner tier={tier ?? "GOOD"} summary={tierSummary} />

      <FieldRow
        icon={Mic}
        title="Continuous chat"
        description="When on, the mic stays open and the agent decides when you finished speaking."
        data-testid="voice-section-continuous-row"
      >
        <ContinuousChatToggle
          value={prefs.continuous}
          onChange={(next) => updatePrefs({ continuous: next })}
          data-testid="voice-section-continuous-toggle"
        />
      </FieldRow>

      <FieldRow
        icon={Sliders}
        title="Wake word"
        description="Listen for a phrase like 'Hey Eliza' before opening the mic."
        data-testid="voice-section-wake-row"
      >
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={wakeWordEnabled}
            onChange={(e) => onWakeWordToggle?.(e.target.checked)}
            data-testid="voice-section-wake-toggle"
            className="h-4 w-4 rounded border-border/40"
            aria-label="Toggle wake word"
          />
          <span className="text-muted">
            {wakeWordEnabled ? "On" : "Off"}
          </span>
        </label>
      </FieldRow>

      <FieldRow
        icon={Cloud}
        title="Local vs Cloud"
        description="Where speech recognition and synthesis run."
      >
        <select
          value={prefs.strategy}
          onChange={(e) =>
            updatePrefs({
              strategy: e.target.value as VoiceLocalCloudStrategy,
            })
          }
          className="rounded border border-border/40 bg-bg/50 px-2 py-1 text-xs"
          data-testid="voice-section-strategy-select"
          aria-label="Local vs Cloud strategy"
        >
          <option value="auto">Auto (recommended)</option>
          <option value="force-local">Force local</option>
          <option value="force-cloud">Force cloud</option>
        </select>
      </FieldRow>

      <div
        className="rounded-lg border border-border/30 bg-card/30 p-3"
        data-testid="voice-section-models"
      >
        <div className="mb-2 flex items-center gap-2">
          <Database className="h-4 w-4 text-muted" aria-hidden />
          <h3 className="text-sm font-semibold">Models</h3>
        </div>
        {modelsPanel ?? (
          <p
            className="text-xs text-muted"
            data-testid="voice-section-models-empty"
          >
            Voice models will appear here once they're available. Voice
            updates appear automatically on Wi-Fi; on cellular we'll ask
            first.
          </p>
        )}
      </div>

      <VoiceProfileSection profilesClient={profilesClient} />

      <div
        className="rounded-lg border border-border/30 bg-card/30 p-3"
        data-testid="voice-section-privacy"
      >
        <div className="mb-2 flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted" aria-hidden />
          <h3 className="text-sm font-semibold">Privacy</h3>
        </div>
        <label className="mb-2 flex cursor-pointer items-center justify-between gap-3 text-xs">
          <span>
            <span className="block text-sm">Cloud first-line cache</span>
            <span className="text-muted">
              Lets Eliza Cloud cache the agent's short opener phrases for
              faster replies. Disabled by default.
            </span>
          </span>
          <input
            type="checkbox"
            checked={prefs.cloudFirstLineCache}
            onChange={(e) =>
              updatePrefs({ cloudFirstLineCache: e.target.checked })
            }
            data-testid="voice-section-cloud-cache-toggle"
            className="h-4 w-4 rounded border-border/40"
            aria-label="Cloud first-line cache opt-in"
          />
        </label>
        <label className="flex cursor-pointer items-center justify-between gap-3 text-xs">
          <span>
            <span className="block text-sm">Auto-learn new voices</span>
            <span className="text-muted">
              When the agent hears an unfamiliar voice, build a profile
              for them automatically.
            </span>
          </span>
          <input
            type="checkbox"
            checked={prefs.autoLearnVoices}
            onChange={(e) =>
              updatePrefs({ autoLearnVoices: e.target.checked })
            }
            data-testid="voice-section-auto-learn-toggle"
            className="h-4 w-4 rounded border-border/40"
            aria-label="Auto-learn new voices"
          />
        </label>
      </div>
    </section>
  );
}

export default VoiceSection;
