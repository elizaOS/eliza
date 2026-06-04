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

import { Cloud, Database, Mic, Shield, Sliders, Timer } from "lucide-react";
import * as React from "react";
import { useAgentElement } from "../../agent-surface";
import type { VoiceProfilesClient } from "../../api/client-voice-profiles";
import { cn } from "../../lib/utils";
import { useTranslation } from "../../state/TranslationContext";
import { DEFAULT_LOCAL_ASR_AUTO_STOP } from "../../voice/local-asr-capture";
import {
  DEFAULT_VOICE_CONTINUOUS_MODE,
  type VoiceContinuousMode,
} from "../../voice/voice-chat-types";
import { ContinuousChatToggle } from "../composites/chat/ContinuousChatToggle";
import { VoiceProfileSection } from "./VoiceProfileSection";
import { type VoiceDeviceTier, VoiceTierBanner } from "./VoiceTierBanner";

export type VoiceLocalCloudStrategy = "auto" | "force-local" | "force-cloud";

/**
 * User-facing slice of {@link LocalAsrAutoStopOptions}: how long silence ends a
 * turn (`silenceMs`) and how loud audio must be to count as speech
 * (`speechRmsThreshold`). The remaining auto-stop fields keep their library
 * defaults — these two are the only knobs worth surfacing.
 */
export interface VadAutoStopPrefs {
  /** Trailing silence (ms) that ends a turn in VAD / local-ASR capture. */
  silenceMs: number;
  /** RMS amplitude (0–1) above which audio is treated as speech. */
  speechRmsThreshold: number;
}

export const DEFAULT_VAD_AUTO_STOP_PREFS: VadAutoStopPrefs = {
  silenceMs: DEFAULT_LOCAL_ASR_AUTO_STOP.silenceMs,
  speechRmsThreshold: DEFAULT_LOCAL_ASR_AUTO_STOP.speechRmsThreshold,
};

/** Bounds for the surfaced sliders, kept well inside sane capture ranges. */
const VAD_SILENCE_MIN_MS = 300;
const VAD_SILENCE_MAX_MS = 3000;
const VAD_SILENCE_STEP_MS = 100;
const VAD_RMS_MIN = 0.001;
const VAD_RMS_MAX = 0.02;
const VAD_RMS_STEP = 0.001;

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

export const DEFAULT_VOICE_SECTION_PREFS: VoiceSectionPrefs = {
  continuous: DEFAULT_VOICE_CONTINUOUS_MODE,
  strategy: "auto",
  cloudFirstLineCache: false,
  autoLearnVoices: true,
  vadAutoStop: DEFAULT_VAD_AUTO_STOP_PREFS,
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
        data-testid="voice-section-vad"
      >
        <div className="mb-2 flex items-center gap-2">
          <Timer className="h-4 w-4 text-muted" aria-hidden />
          <h3 className="text-sm font-semibold">
            {t("voicesection.endOfTurn", { defaultValue: "End of turn" })}
          </h3>
        </div>
        <p className="mb-3 text-xs text-muted">
          {t("voicesection.endOfTurnDesc", {
            defaultValue:
              "Tune how on-device VAD decides you've finished speaking. Applies to VAD-gated and continuous capture with local speech recognition.",
          })}
        </p>

        <label className="mb-3 block text-xs">
          <span className="mb-1 flex items-center justify-between">
            <span className="text-sm">
              {t("voicesection.silenceDuration", {
                defaultValue: "Silence before end of turn",
              })}
            </span>
            <span
              className="font-medium text-muted"
              data-testid="voice-section-vad-silence-value"
            >
              {(vadAutoStop.silenceMs / 1000).toFixed(1)}s
            </span>
          </span>
          <input
            type="range"
            min={VAD_SILENCE_MIN_MS}
            max={VAD_SILENCE_MAX_MS}
            step={VAD_SILENCE_STEP_MS}
            value={vadAutoStop.silenceMs}
            onChange={(e) =>
              updateVadAutoStop({ silenceMs: Number(e.target.value) })
            }
            className="w-full accent-accent"
            data-testid="voice-section-vad-silence"
            aria-label={t("voicesection.silenceDuration", {
              defaultValue: "Silence before end of turn",
            })}
          />
        </label>

        <label className="block text-xs">
          <span className="mb-1 flex items-center justify-between">
            <span className="text-sm">
              {t("voicesection.micSensitivity", {
                defaultValue: "Speech detection threshold",
              })}
            </span>
            <span
              className="font-medium text-muted"
              data-testid="voice-section-vad-rms-value"
            >
              {vadAutoStop.speechRmsThreshold.toFixed(3)}
            </span>
          </span>
          <input
            type="range"
            min={VAD_RMS_MIN}
            max={VAD_RMS_MAX}
            step={VAD_RMS_STEP}
            value={vadAutoStop.speechRmsThreshold}
            onChange={(e) =>
              updateVadAutoStop({
                speechRmsThreshold: Number(e.target.value),
              })
            }
            className="w-full accent-accent"
            data-testid="voice-section-vad-rms"
            aria-label={t("voicesection.micSensitivity", {
              defaultValue: "Speech detection threshold",
            })}
          />
          <span className="mt-1 flex justify-between text-[10px] text-muted">
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
        </label>
      </div>

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
