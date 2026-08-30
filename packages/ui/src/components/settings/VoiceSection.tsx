/**
 * VoiceSection — top-level Settings → Voice tree. Mounts the device-tier
 * banner, continuous-chat mode, wake word, end-of-turn tuning, the models
 * slot, and voice profiles.
 *
 * Per-modality local-vs-cloud routing is owned by the RoutingMatrix control
 * (per-slot policy rows), not by this section.
 */

import { Database, Mic, Sliders, Timer } from "lucide-react";
import * as React from "react";
import { useAgentElement } from "../../agent-surface";
import type { VoiceProfilesClient } from "../../api/client-voice-profiles";
import { cn } from "../../lib/utils";
import { useTranslation } from "../../state/TranslationContext.hooks";
import type { VoiceContinuousMode } from "../../voice/voice-chat-types";
import { ContinuousChatToggle } from "../composites/chat/ContinuousChatToggle";
import { Input } from "../ui/input";
import { AdvancedToggle } from "./AdvancedToggle";
import { useAdvancedSettingsEnabled } from "./AdvancedToggle.hooks";
import { PendantSettingsCard } from "./PendantSettingsCard";
import { SettingsSwitchRow } from "./settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";
import { VoiceProfileSection } from "./VoiceProfileSection";
import { DEFAULT_VAD_AUTO_STOP_PREFS } from "./VoiceSection.helpers";
import { type VoiceDeviceTier, VoiceTierBanner } from "./VoiceTierBanner";

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
 * can read and set it. Uses the shared Input primitive while preserving the
 * native range control contract.
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
      <Input
        ref={ref}
        type="range"
        variant="nativeRange"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        data-testid={testId}
        aria-label={label}
        {...agentProps}
      />
    </div>
  );
}

export interface VoiceSectionPrefs {
  continuous: VoiceContinuousMode;
  /** Consent for OS shortcuts/deep links to start capture without another tap. */
  osIntentAutoStartVoice: boolean;
  osIntentAutoStartTranscription: boolean;
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
  /**
   * Cloud-only consumer builds manage voice models remotely and must not
   * advertise a local model-download/configuration surface.
   */
  showModelsPanel?: boolean;
  /**
   * Whether the "hey <name>" wake-word listening loop is enabled. Wired by
   * VoiceSectionMount to the persisted device-local pref the shell's
   * useWakeListenWindow reads; defaults off only when no caller supplies it.
   */
  wakeWordEnabled?: boolean;
  /** Toggle wake-word listening on/off (persisted + read by the shell). */
  onWakeWordToggle?: (next: boolean) => void;
  /** Shared controls that should lead the canonical Voice stack. */
  leadingContent?: React.ReactNode;
  className?: string;
}

export function VoiceSection({
  tier,
  tierSummary,
  prefs,
  onPrefsChange,
  profilesClient,
  modelsPanel,
  showModelsPanel = true,
  wakeWordEnabled = false,
  onWakeWordToggle,
  leadingContent,
  className,
}: VoiceSectionProps): React.ReactElement {
  const { t } = useTranslation();
  const advancedEnabled = useAdvancedSettingsEnabled();
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

  return (
    <section data-testid="voice-section" className={cn(className)}>
      <SettingsStack>
        {leadingContent}
        <SettingsGroup bare>
          <VoiceTierBanner
            tier={tier ?? "GOOD"}
            summary={tierSummary}
            compact
          />
        </SettingsGroup>

        <PendantSettingsCard />

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

          <SettingsSwitchRow
            agentId="voice-section-wake-toggle"
            testId="voice-section-wake-toggle"
            group="voice-section"
            icon={Sliders}
            label={t("voicesection.wakeWord", { defaultValue: "Wake word" })}
            checked={wakeWordEnabled}
            disabled={!onWakeWordToggle}
            agentStatus={wakeWordEnabled ? "active" : "inactive"}
            onCheckedChange={(checked) => onWakeWordToggle?.(checked)}
          />

          <SettingsSwitchRow
            agentId="voice-section-intent-autostart-voice"
            testId="voice-section-intent-autostart-voice"
            group="voice-section"
            icon={Mic}
            label={t("voicesection.intentAutoStartVoice", {
              defaultValue: "Allow voice shortcuts to start the microphone",
            })}
            checked={prefs.osIntentAutoStartVoice}
            agentStatus={prefs.osIntentAutoStartVoice ? "active" : "inactive"}
            onCheckedChange={(checked) =>
              updatePrefs({ osIntentAutoStartVoice: checked })
            }
          />
          <SettingsSwitchRow
            agentId="voice-section-intent-autostart-transcription"
            testId="voice-section-intent-autostart-transcription"
            group="voice-section"
            icon={Mic}
            label={t("voicesection.intentAutoStartTranscription", {
              defaultValue:
                "Allow transcription shortcuts to start the microphone",
            })}
            description={t("voicesection.intentAutoStartHint", {
              defaultValue:
                "Off by default. Turn either option off here at any time.",
            })}
            checked={prefs.osIntentAutoStartTranscription}
            agentStatus={
              prefs.osIntentAutoStartTranscription ? "active" : "inactive"
            }
            onCheckedChange={(checked) =>
              updatePrefs({ osIntentAutoStartTranscription: checked })
            }
          />
        </SettingsGroup>

        <SettingsGroup
          title={t("voicesection.endOfTurn", { defaultValue: "End of turn" })}
          action={<AdvancedToggle label="Advanced" />}
          data-testid="voice-section-vad"
        >
          {advancedEnabled ? (
            <>
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
                />
              </SettingsRow>
            </>
          ) : null}
        </SettingsGroup>

        {showModelsPanel ? (
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
        ) : null}

        <SettingsGroup
          bare
          title={t("voiceprofile.title", { defaultValue: "Voice profiles" })}
        >
          <VoiceProfileSection profilesClient={profilesClient} />
        </SettingsGroup>

        {/*
          The former "Privacy" group ("Cloud first-line cache" and
          "Auto-learn new voices" toggles) was removed: both persisted to
          `messages.voice.{cloudFirstLineCache,autoLearnVoices}` but NOTHING
          reads those keys, so they were dead privacy opt-ins. The first-line
          cache implementation exists (`wrapWithFirstLineCache`, wired
          unconditionally via
          packages/app-core/src/runtime/tts-cache-wiring.ts →
          tts-provider-registry.ts) but does not consult the setting; gate that
          consumer on `messages.voice.cloudFirstLineCache` before re-adding the
          toggle. `autoLearnVoices` has no consumer anywhere — build the
          voice-profile auto-learn pipeline first.
        */}
      </SettingsStack>
    </section>
  );
}

export default VoiceSection;
