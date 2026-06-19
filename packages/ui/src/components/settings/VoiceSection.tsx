/**
 * VoiceSection — top-level Settings → Voice tree. Mounts the device-tier
 * banner, continuous-chat mode, wake word, local-vs-cloud strategy,
 * end-of-turn tuning, the models slot, voice profiles, and privacy toggles.
 */

import { Cloud, Database, Mic, Shield, Sliders, Timer } from "lucide-react";
import * as React from "react";
import { useAgentElement } from "../../agent-surface";
import type { VoiceProfilesClient } from "../../api/client-voice-profiles";
import { cn } from "../../lib/utils";
import { useTranslation } from "../../state/TranslationContext.hooks";
import type { VoiceContinuousMode } from "../../voice/voice-chat-types";
import { ContinuousChatToggle } from "../composites/chat/ContinuousChatToggle";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";
import { VoiceProfileSection } from "./VoiceProfileSection";
import { DEFAULT_VAD_AUTO_STOP_PREFS } from "./VoiceSection.helpers";
import { type VoiceDeviceTier, VoiceTierBanner } from "./VoiceTierBanner";

export type VoiceLocalCloudStrategy = "auto" | "force-local" | "force-cloud";

/**
 * User-facing slice of the auto-stop options: how long silence ends a turn
 * and how loud audio must be to count as speech. Other fields keep library
 * defaults — these two are the only knobs worth surfacing.
 */
export interface VadAutoStopPrefs {
  /** Trailing silence (ms) that ends a turn in VAD / local-ASR capture. */
  silenceMs: number;
  /** RMS amplitude (0–1) above which audio is treated as speech. */
  speechRmsThreshold: number;
}

/** Bounds for the surfaced sliders, kept well inside sane capture ranges. */
const VAD_SILENCE_MIN_MS = 300;
const VAD_SILENCE_MAX_MS = 3000;
const VAD_SILENCE_STEP_MS = 100;
const VAD_RMS_MIN = 0.001;
const VAD_RMS_MAX = 0.02;
const VAD_RMS_STEP = 0.001;

/**
 * A range slider that registers on the agent surface (role "slider") so chat
 * can read and set it. Renders the same native `<input type=range>` the rest
 * of the section uses.
 */
function VadSlider({
  agentId,
  label,
  value,
  valueText,
  min,
  max,
  step,
  onChange,
  testId,
  footer,
}: {
  agentId: string;
  label: string;
  value: number;
  valueText: string;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  testId: string;
  footer?: React.ReactNode;
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: agentId,
    role: "slider",
    label,
    group: "voice-section",
    getValue: () => value,
    onFill: (next) => {
      const n = Number(next);
      if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
    },
  });
  return (
    <div className="flex flex-col">
      <div className="mb-1 flex items-center justify-end">
        <span
          className="font-medium text-muted"
          data-testid={`${testId}-value`}
        >
          {valueText}
        </span>
      </div>
      <input
        ref={ref}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-accent"
        data-testid={testId}
        aria-label={label}
        {...agentProps}
      />
      {footer}
    </div>
  );
}

export interface VoiceSectionPrefs {
  continuous: VoiceContinuousMode;
  strategy: VoiceLocalCloudStrategy;
  cloudFirstLineCache: boolean;
  autoLearnVoices: boolean;
  /**
   * VAD / local-ASR end-of-turn tuning. Optional so older persisted prefs (and
   * the registry mount) stay valid; falls back to {@link DEFAULT_VAD_AUTO_STOP_PREFS}.
   */
  vadAutoStop?: VadAutoStopPrefs;
}

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
   * we render an empty-state banner until model downloads are available.
   */
  modelsPanel?: React.ReactNode;
  /** Whether the user has at least one wake-word configured. */
  wakeWordEnabled?: boolean;
  /** Toggle wake-word listening (caller wires Swabble). */
  onWakeWordToggle?: (next: boolean) => void;
  className?: string;
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

  const vadAutoStop = prefs.vadAutoStop ?? DEFAULT_VAD_AUTO_STOP_PREFS;
  const updateVadAutoStop = React.useCallback(
    (patch: Partial<VadAutoStopPrefs>) => {
      updatePrefs({
        vadAutoStop: {
          ...(prefs.vadAutoStop ?? DEFAULT_VAD_AUTO_STOP_PREFS),
          ...patch,
        },
      });
    },
    [prefs.vadAutoStop, updatePrefs],
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
    <section data-testid="voice-section" className={cn(className)}>
      <SettingsStack>
        <SettingsGroup bare>
          <VoiceTierBanner tier={tier ?? "GOOD"} summary={tierSummary} />
        </SettingsGroup>

        <SettingsGroup
          title={t("voicesection.chatGroupTitle", {
            defaultValue: "Voice chat",
          })}
        >
          <SettingsRow
            icon={Mic}
            label={t("voicesection.continuousChat", {
              defaultValue: "Continuous chat",
            })}
            description={t("voicesection.continuousChatDesc", {
              defaultValue: "Mic stays open; the agent detects when you stop.",
            })}
            stacked
          >
            <div data-testid="voice-section-continuous-row">
              <ContinuousChatToggle
                value={prefs.continuous}
                onChange={(next) => updatePrefs({ continuous: next })}
                data-testid="voice-section-continuous-toggle"
              />
            </div>
          </SettingsRow>

          <SettingsRow
            icon={Sliders}
            label={t("voicesection.wakeWord", { defaultValue: "Wake word" })}
            description={t("voicesection.wakeWordDesc", {
              defaultValue:
                "Listen for a phrase like 'Hey Eliza' before opening the mic.",
            })}
            control={
              <label
                className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 text-sm"
                data-testid="voice-section-wake-row"
              >
                <input
                  ref={wakeWordRef}
                  type="checkbox"
                  checked={wakeWordEnabled}
                  onChange={(e) => onWakeWordToggle?.(e.target.checked)}
                  data-testid="voice-section-wake-toggle"
                  className="h-5 w-5 rounded-sm border-border accent-accent"
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
            }
          />

          <SettingsRow
            icon={Cloud}
            label={t("voicesection.localVsCloud", {
              defaultValue: "Local vs Cloud",
            })}
            description={t("voicesection.localVsCloudDesc", {
              defaultValue: "Where speech recognition and synthesis run.",
            })}
            stacked
          >
            <select
              ref={strategyRef}
              value={prefs.strategy}
              onChange={(e) =>
                updatePrefs({
                  strategy: e.target.value as VoiceLocalCloudStrategy,
                })
              }
              className="h-11 w-full rounded-md border border-border bg-card px-3 text-sm text-txt transition-colors focus:border-accent focus:outline-none"
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
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup
          title={t("voicesection.endOfTurn", { defaultValue: "End of turn" })}
          description={t("voicesection.endOfTurnDesc", {
            defaultValue:
              "Tune how on-device VAD decides you've finished speaking.",
          })}
          data-testid="voice-section-vad"
        >
          <SettingsRow
            icon={Timer}
            label={t("voicesection.silenceDuration", {
              defaultValue: "Silence before end of turn",
            })}
            stacked
          >
            <VadSlider
              agentId="voice-section-vad-silence"
              testId="voice-section-vad-silence"
              label={t("voicesection.silenceDuration", {
                defaultValue: "Silence before end of turn",
              })}
              value={vadAutoStop.silenceMs}
              valueText={`${(vadAutoStop.silenceMs / 1000).toFixed(1)}s`}
              min={VAD_SILENCE_MIN_MS}
              max={VAD_SILENCE_MAX_MS}
              step={VAD_SILENCE_STEP_MS}
              onChange={(silenceMs) => updateVadAutoStop({ silenceMs })}
            />
          </SettingsRow>
          <SettingsRow
            icon={Timer}
            label={t("voicesection.micSensitivity", {
              defaultValue: "Speech detection threshold",
            })}
            stacked
          >
            <VadSlider
              agentId="voice-section-vad-rms"
              testId="voice-section-vad-rms"
              label={t("voicesection.micSensitivity", {
                defaultValue: "Speech detection threshold",
              })}
              value={vadAutoStop.speechRmsThreshold}
              valueText={vadAutoStop.speechRmsThreshold.toFixed(3)}
              min={VAD_RMS_MIN}
              max={VAD_RMS_MAX}
              step={VAD_RMS_STEP}
              onChange={(speechRmsThreshold) =>
                updateVadAutoStop({ speechRmsThreshold })
              }
              footer={
                <span className="mt-1 flex justify-between text-xs text-muted">
                  <span>
                    {t("voicesection.thresholdLower", {
                      defaultValue: "More sensitive",
                    })}
                  </span>
                  <span>
                    {t("voicesection.thresholdHigher", {
                      defaultValue: "Less sensitive",
                    })}
                  </span>
                </span>
              }
            />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup
          title={t("voicesection.models", { defaultValue: "Models" })}
          data-testid="voice-section-models"
        >
          {modelsPanel ?? (
            <SettingsRow
              icon={Database}
              label={t("voicesection.models", { defaultValue: "Models" })}
              description={
                <span data-testid="voice-section-models-empty">
                  {t("voicesection.modelsEmpty", {
                    defaultValue: "Voice models appear here when available.",
                  })}
                </span>
              }
            />
          )}
        </SettingsGroup>

        <SettingsGroup
          bare
          title={t("voiceprofile.title", { defaultValue: "Voice profiles" })}
        >
          <VoiceProfileSection profilesClient={profilesClient} />
        </SettingsGroup>

        <SettingsGroup
          title={t("voicesection.privacy", { defaultValue: "Privacy" })}
          data-testid="voice-section-privacy"
        >
          <SettingsRow
            icon={Shield}
            label={t("voicesection.cloudFirstLineCache", {
              defaultValue: "Cloud first-line cache",
            })}
            description={t("voicesection.cloudFirstLineCacheDesc", {
              defaultValue:
                "Lets Eliza Cloud cache the agent's short opener phrases for faster replies.",
            })}
            control={
              <input
                ref={cloudCacheRef}
                type="checkbox"
                checked={prefs.cloudFirstLineCache}
                onChange={(e) =>
                  updatePrefs({ cloudFirstLineCache: e.target.checked })
                }
                data-testid="voice-section-cloud-cache-toggle"
                className="h-5 w-5 rounded-sm border-border accent-accent"
                aria-current={prefs.cloudFirstLineCache ? "true" : undefined}
                aria-label={t("voicesection.cloudFirstLineCacheAria", {
                  defaultValue: "Cloud first-line cache opt-in",
                })}
                {...cloudCacheAgentProps}
              />
            }
          />
          <SettingsRow
            icon={Shield}
            label={t("voicesection.autoLearnVoices", {
              defaultValue: "Auto-learn new voices",
            })}
            description={t("voicesection.autoLearnVoicesDesc", {
              defaultValue:
                "When the agent hears an unfamiliar voice, build a profile for them automatically.",
            })}
            control={
              <input
                ref={autoLearnRef}
                type="checkbox"
                checked={prefs.autoLearnVoices}
                onChange={(e) =>
                  updatePrefs({ autoLearnVoices: e.target.checked })
                }
                data-testid="voice-section-auto-learn-toggle"
                className="h-5 w-5 rounded-sm border-border accent-accent"
                aria-current={prefs.autoLearnVoices ? "true" : undefined}
                aria-label={t("voicesection.autoLearnVoices", {
                  defaultValue: "Auto-learn new voices",
                })}
                {...autoLearnAgentProps}
              />
            }
          />
        </SettingsGroup>
      </SettingsStack>
    </section>
  );
}

export default VoiceSection;
