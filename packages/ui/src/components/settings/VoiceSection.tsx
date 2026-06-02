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

import { Cloud, Database, Mic, Shield, Sliders } from "lucide-react";
import * as React from "react";
import { useAgentElement } from "../../agent-surface";
import type { VoiceProfilesClient } from "../../api/client-voice-profiles";
import { cn } from "../../lib/utils";
import { useTranslation } from "../../state/TranslationContext";
import {
  DEFAULT_VOICE_CONTINUOUS_MODE,
  type VoiceContinuousMode,
} from "../../voice/voice-chat-types";
import { ContinuousChatToggle } from "../composites/chat/ContinuousChatToggle";
import { VoiceProfileSection } from "./VoiceProfileSection";
import { type VoiceDeviceTier, VoiceTierBanner } from "./VoiceTierBanner";

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
      className="flex items-start justify-between gap-3 rounded-sm border border-border/30 bg-card/30 p-3"
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
  const { t } = useTranslation();
  const updatePrefs = React.useCallback(
    (patch: Partial<VoiceSectionPrefs>) => {
      onPrefsChange({ ...prefs, ...patch });
    },
    [onPrefsChange, prefs],
  );

  const { ref: wakeWordRef, agentProps: wakeWordAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "voice-section-wake-toggle",
      role: "toggle",
      label: t("voicesection.toggleWakeWord", {
        defaultValue: "Toggle wake word",
      }),
      group: "voice-section",
      status: wakeWordEnabled ? "active" : "inactive",
      onActivate: () => onWakeWordToggle?.(!wakeWordEnabled),
    });
  const { ref: strategyRef, agentProps: strategyAgentProps } =
    useAgentElement<HTMLSelectElement>({
      id: "voice-section-strategy-select",
      role: "select",
      label: t("voicesection.localVsCloudStrategy", {
        defaultValue: "Local vs Cloud strategy",
      }),
      group: "voice-section",
      getValue: () => prefs.strategy,
      onFill: (value) =>
        updatePrefs({ strategy: value as VoiceLocalCloudStrategy }),
      options: ["auto", "force-local", "force-cloud"],
    });
  const { ref: cloudCacheRef, agentProps: cloudCacheAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "voice-section-cloud-cache-toggle",
      role: "toggle",
      label: t("voicesection.cloudFirstLineCacheAria", {
        defaultValue: "Cloud first-line cache opt-in",
      }),
      group: "voice-section",
      status: prefs.cloudFirstLineCache ? "active" : "inactive",
      onActivate: () =>
        updatePrefs({ cloudFirstLineCache: !prefs.cloudFirstLineCache }),
    });
  const { ref: autoLearnRef, agentProps: autoLearnAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "voice-section-auto-learn-toggle",
      role: "toggle",
      label: t("voicesection.autoLearnVoices", {
        defaultValue: "Auto-learn new voices",
      }),
      group: "voice-section",
      status: prefs.autoLearnVoices ? "active" : "inactive",
      onActivate: () =>
        updatePrefs({ autoLearnVoices: !prefs.autoLearnVoices }),
    });

  return (
    <section
      data-testid="voice-section"
      className={cn("flex flex-col gap-4 p-4 sm:p-5", className)}
    >
      <VoiceTierBanner tier={tier ?? "GOOD"} summary={tierSummary} />

      <FieldRow
        icon={Mic}
        title={t("voicesection.continuousChat", {
          defaultValue: "Continuous chat",
        })}
        description={t("voicesection.continuousChatDesc", {
          defaultValue:
            "When on, the mic stays open and the agent decides when you finished speaking.",
        })}
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
        title={t("voicesection.wakeWord", { defaultValue: "Wake word" })}
        description={t("voicesection.wakeWordDesc", {
          defaultValue:
            "Listen for a phrase like 'Hey Eliza' before opening the mic.",
        })}
        data-testid="voice-section-wake-row"
      >
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
          <input
            ref={wakeWordRef}
            type="checkbox"
            checked={wakeWordEnabled}
            onChange={(e) => onWakeWordToggle?.(e.target.checked)}
            data-testid="voice-section-wake-toggle"
            className="h-4 w-4 rounded-sm border-border/40"
            aria-current={wakeWordEnabled ? "true" : undefined}
            aria-label={t("voicesection.toggleWakeWord", {
              defaultValue: "Toggle wake word",
            })}
            {...wakeWordAgentProps}
          />
          <span className="text-muted">
            {wakeWordEnabled
              ? t("voicesection.on", { defaultValue: "On" })
              : t("voicesection.off", { defaultValue: "Off" })}
          </span>
        </label>
      </FieldRow>

      <FieldRow
        icon={Cloud}
        title={t("voicesection.localVsCloud", {
          defaultValue: "Local vs Cloud",
        })}
        description={t("voicesection.localVsCloudDesc", {
          defaultValue: "Where speech recognition and synthesis run.",
        })}
      >
        <select
          ref={strategyRef}
          value={prefs.strategy}
          onChange={(e) =>
            updatePrefs({
              strategy: e.target.value as VoiceLocalCloudStrategy,
            })
          }
          className="rounded-sm border border-border/40 bg-bg/50 px-2 py-1 text-xs"
          data-testid="voice-section-strategy-select"
          aria-label={t("voicesection.localVsCloudStrategy", {
            defaultValue: "Local vs Cloud strategy",
          })}
          {...strategyAgentProps}
        >
          <option value="auto">
            {t("voicesection.strategyAuto", {
              defaultValue: "Auto (recommended)",
            })}
          </option>
          <option value="force-local">
            {t("voicesection.strategyForceLocal", {
              defaultValue: "Force local",
            })}
          </option>
          <option value="force-cloud">
            {t("voicesection.strategyForceCloud", {
              defaultValue: "Force cloud",
            })}
          </option>
        </select>
      </FieldRow>

      <div
        className="rounded-sm border border-border/30 bg-card/30 p-3"
        data-testid="voice-section-models"
      >
        <div className="mb-2 flex items-center gap-2">
          <Database className="h-4 w-4 text-muted" aria-hidden />
          <h3 className="text-sm font-semibold">
            {t("voicesection.models", { defaultValue: "Models" })}
          </h3>
        </div>
        {modelsPanel ?? (
          <p
            className="text-xs text-muted"
            data-testid="voice-section-models-empty"
          >
            {t("voicesection.modelsEmpty", {
              defaultValue:
                "Voice models will appear here once they're available. Voice updates appear automatically on Wi-Fi; on cellular we'll ask first.",
            })}
          </p>
        )}
      </div>

      <VoiceProfileSection profilesClient={profilesClient} />

      <div
        className="rounded-sm border border-border/30 bg-card/30 p-3"
        data-testid="voice-section-privacy"
      >
        <div className="mb-2 flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted" aria-hidden />
          <h3 className="text-sm font-semibold">
            {t("voicesection.privacy", { defaultValue: "Privacy" })}
          </h3>
        </div>
        <label className="mb-2 flex cursor-pointer items-center justify-between gap-3 text-xs">
          <span>
            <span className="block text-sm">
              {t("voicesection.cloudFirstLineCache", {
                defaultValue: "Cloud first-line cache",
              })}
            </span>
            <span className="text-muted">
              {t("voicesection.cloudFirstLineCacheDesc", {
                defaultValue:
                  "Lets Eliza Cloud cache the agent's short opener phrases for faster replies. Disabled by default.",
              })}
            </span>
          </span>
          <input
            ref={cloudCacheRef}
            type="checkbox"
            checked={prefs.cloudFirstLineCache}
            onChange={(e) =>
              updatePrefs({ cloudFirstLineCache: e.target.checked })
            }
            data-testid="voice-section-cloud-cache-toggle"
            className="h-4 w-4 rounded-sm border-border/40"
            aria-current={prefs.cloudFirstLineCache ? "true" : undefined}
            aria-label={t("voicesection.cloudFirstLineCacheAria", {
              defaultValue: "Cloud first-line cache opt-in",
            })}
            {...cloudCacheAgentProps}
          />
        </label>
        <label className="flex cursor-pointer items-center justify-between gap-3 text-xs">
          <span>
            <span className="block text-sm">
              {t("voicesection.autoLearnVoices", {
                defaultValue: "Auto-learn new voices",
              })}
            </span>
            <span className="text-muted">
              {t("voicesection.autoLearnVoicesDesc", {
                defaultValue:
                  "When the agent hears an unfamiliar voice, build a profile for them automatically.",
              })}
            </span>
          </span>
          <input
            ref={autoLearnRef}
            type="checkbox"
            checked={prefs.autoLearnVoices}
            onChange={(e) => updatePrefs({ autoLearnVoices: e.target.checked })}
            data-testid="voice-section-auto-learn-toggle"
            className="h-4 w-4 rounded-sm border-border/40"
            aria-current={prefs.autoLearnVoices ? "true" : undefined}
            aria-label={t("voicesection.autoLearnVoices", {
              defaultValue: "Auto-learn new voices",
            })}
            {...autoLearnAgentProps}
          />
        </label>
      </div>
    </section>
  );
}

export default VoiceSection;
