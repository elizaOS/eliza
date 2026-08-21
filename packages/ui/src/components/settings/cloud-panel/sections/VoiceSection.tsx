/**
 * Voice section for the cloud-only settings panel — TTS (provider, voice,
 * speed, test), STT (voice profile, VAD auto-stop, silence threshold, wake
 * word), and conversation (continuous chat, OS intent auto-start).
 *
 * Reuses the TTS selection + preview pattern from IdentitySettingsSection and
 * the voice-prefs persistence pattern from VoiceSectionMount, collapsed into a
 * single no-prop section the cloud panel registry mounts.
 */

import { Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client, type VoiceConfig } from "../../../../api";
import {
  createVoiceProfilesClient,
  type VoiceProfile,
} from "../../../../api/client-voice-profiles";
import {
  dispatchWindowEvent,
  VOICE_CONFIG_UPDATED_EVENT,
} from "../../../../events";
import {
  loadWakeWordEnabled,
  saveContinuousChatMode,
  saveOsIntentAutoStartConsent,
  saveVadAutoStop,
  saveWakeWordEnabled,
} from "../../../../state/persistence";
import { useTranslation } from "../../../../state/TranslationContext.hooks";
import { EDGE_BACKUP_VOICES, PREMADE_VOICES } from "../../../../voice/types";
import type { VoiceContinuousMode } from "../../../../voice/voice-chat-types";
import {
  DEFAULT_ELEVEN_FAST_MODEL,
  EDGE_VOICE_GROUPS,
  ELEVENLABS_VOICE_GROUPS,
} from "../../../character/character-voice-config";
import { SaveFooter } from "../../../ui/save-footer";
import {
  SettingsGroup,
  SettingsStack,
  NuphySwitchRow,
  NuphySelectRow,
  NuphyInputRow,
  NuphyActionButton,
  NuphySliderRow,
} from "../nuphy-settings-primitives";
import { useSettingsSave } from "../../settings-control-primitives.hooks";

const TTS_CONFIG_KEY = "tts";
const VOICE_PREFS_CONFIG_KEY = "voice";

const SPEED_MIN = 0.5;
const SPEED_MAX = 2.0;
const SPEED_STEP = 0.1;
const SPEED_DEFAULT = 1.0;

const SILENCE_MIN_MS = 200;
const SILENCE_MAX_MS = 3000;
const SILENCE_STEP_MS = 100;
const SILENCE_DEFAULT_MS = 800;

const profilesClient = createVoiceProfilesClient(client);

interface VoicePrefs {
  continuous: VoiceContinuousMode;
  osIntentAutoStartVoice: boolean;
  osIntentAutoStartTranscription: boolean;
  vadAutoStopEnabled: boolean;
  silenceMs: number;
  wakeWord: string;
  selectedVoiceProfileId: string;
}

const DEFAULT_VOICE_PREFS: VoicePrefs = {
  continuous: "off",
  osIntentAutoStartVoice: false,
  osIntentAutoStartTranscription: false,
  vadAutoStopEnabled: false,
  silenceMs: SILENCE_DEFAULT_MS,
  wakeWord: "",
  selectedVoiceProfileId: "",
};

function resolveProvider(config: VoiceConfig): "elevenlabs" | "edge" {
  return config.provider === "edge" ? "edge" : "elevenlabs";
}

function resolveSpeed(config: VoiceConfig): number {
  if (resolveProvider(config) === "edge") {
    const raw = config.edge?.rate;
    if (typeof raw === "string") {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
    return SPEED_DEFAULT;
  }
  const speed = config.elevenlabs?.speed;
  return typeof speed === "number" && Number.isFinite(speed)
    ? speed
    : SPEED_DEFAULT;
}

function resolveVoicePresetId(
  config: VoiceConfig,
  useElevenLabs: boolean,
): string | null {
  if (useElevenLabs) {
    const voiceId =
      typeof config.elevenlabs?.voiceId === "string"
        ? config.elevenlabs.voiceId.trim()
        : "";
    if (!voiceId) return null;
    return PREMADE_VOICES.find((p) => p.voiceId === voiceId)?.id ?? null;
  }
  const voiceId =
    typeof config.edge?.voice === "string" ? config.edge.voice.trim() : "";
  if (!voiceId) return null;
  return EDGE_BACKUP_VOICES.find((p) => p.voiceId === voiceId)?.id ?? null;
}

export function VoiceSection() {
  const { t } = useTranslation();
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>({});
  const [savedVoiceConfig, setSavedVoiceConfig] = useState<VoiceConfig>({});
  const [prefs, setPrefs] = useState<VoicePrefs>(DEFAULT_VOICE_PREFS);
  const [savedPrefs, setSavedPrefs] = useState<VoicePrefs>(DEFAULT_VOICE_PREFS);
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [voiceTesting, setVoiceTesting] = useState(false);
  const [loading, setLoading] = useState(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Load TTS config, voice prefs, and voice profiles on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await client.getConfig();
        if (cancelled) return;
        const messages = (config.messages ?? {}) as Record<string, unknown>;
        const tts = (messages[TTS_CONFIG_KEY] as VoiceConfig | undefined) ?? {};
        setVoiceConfig(tts);
        setSavedVoiceConfig(tts);
        const stored = (messages[VOICE_PREFS_CONFIG_KEY] ?? {}) as Record<
          string,
          unknown
        >;
        const loaded: VoicePrefs = {
          ...DEFAULT_VOICE_PREFS,
          continuous:
            (stored.continuous as VoiceContinuousMode | undefined) ??
            DEFAULT_VOICE_PREFS.continuous,
          osIntentAutoStartVoice: stored.osIntentAutoStartVoice === true,
          osIntentAutoStartTranscription:
            stored.osIntentAutoStartTranscription === true,
          vadAutoStopEnabled: stored.vadAutoStopEnabled === true,
          silenceMs:
            typeof stored.silenceMs === "number"
              ? stored.silenceMs
              : SILENCE_DEFAULT_MS,
          wakeWord: typeof stored.wakeWord === "string" ? stored.wakeWord : "",
          selectedVoiceProfileId:
            typeof stored.selectedVoiceProfileId === "string"
              ? stored.selectedVoiceProfileId
              : "",
        };
        setPrefs(loaded);
        setSavedPrefs(loaded);
      } catch {
        // Config fetch failed — keep defaults so the panel still renders.
      } finally {
        if (!cancelled) setLoading(false);
      }
      try {
        const list = await profilesClient.list();
        if (!cancelled) setProfiles(list);
      } catch {
        // Profiles endpoint unavailable — dropdown stays empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Seed wake-word from the persisted device-local pref.
  useEffect(() => {
    setWakeWordEnabled(loadWakeWordEnabled());
  }, []);

  // Stop any in-flight preview audio on unmount.
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const provider = resolveProvider(voiceConfig);
  const useElevenLabs = provider === "elevenlabs";
  const speed = resolveSpeed(voiceConfig);

  const visibleVoicePresetId = useMemo(
    () => resolveVoicePresetId(voiceConfig, useElevenLabs),
    [voiceConfig, useElevenLabs],
  );

  const activeVoicePreset = useMemo(() => {
    const presets = useElevenLabs ? PREMADE_VOICES : EDGE_BACKUP_VOICES;
    return presets.find((p) => p.id === visibleVoicePresetId) ?? null;
  }, [useElevenLabs, visibleVoicePresetId]);

  const voiceGroups = useMemo(() => {
    const groups = useElevenLabs ? ELEVENLABS_VOICE_GROUPS : EDGE_VOICE_GROUPS;
    const presets = useElevenLabs ? PREMADE_VOICES : EDGE_BACKUP_VOICES;
    return groups.map((group) => ({
      label: t(group.labelKey, { defaultValue: group.defaultLabel }),
      items: group.items.map((item) => {
        const preset = presets.find((entry) => entry.id === item.id);
        return {
          value: item.id,
          label: preset?.nameKey
            ? t(preset.nameKey, { defaultValue: preset.name })
            : (preset?.name ?? item.text),
          hint: preset?.hintKey
            ? t(preset.hintKey, { defaultValue: preset.hint })
            : preset?.hint,
        };
      }),
    }));
  }, [t, useElevenLabs]);

  const voiceOptions = useMemo(
    () =>
      voiceGroups.flatMap((group) =>
        group.items.map((item) => ({
          value: item.value,
          label: item.label,
        })),
      ),
    [voiceGroups],
  );

  const profileOptions = useMemo(
    () =>
      profiles.map((p) => ({
        value: p.id,
        label: p.isOwner ? `${p.displayName} (Owner)` : p.displayName,
      })),
    [profiles],
  );

  const stopVoicePreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    setVoiceTesting(false);
  }, []);

  const handlePreviewVoice = useCallback(() => {
    if (!activeVoicePreset?.previewUrl) return;
    stopVoicePreview();
    setVoiceTesting(true);
    const audio = new Audio(activeVoicePreset.previewUrl);
    audioRef.current = audio;
    audio.onended = () => {
      audioRef.current = null;
      setVoiceTesting(false);
    };
    audio.onerror = () => {
      audioRef.current = null;
      setVoiceTesting(false);
    };
    audio.play().catch(() => {
      audioRef.current = null;
      setVoiceTesting(false);
    });
  }, [activeVoicePreset, stopVoicePreview]);

  const handleProviderChange = useCallback((nextProvider: string) => {
    setVoiceConfig((prev) => {
      if (nextProvider === "edge") {
        return { ...prev, provider: "edge", edge: prev.edge ?? {} };
      }
      return {
        ...prev,
        provider: "elevenlabs",
        elevenlabs: {
          ...(prev.elevenlabs ?? {}),
          modelId: prev.elevenlabs?.modelId ?? DEFAULT_ELEVEN_FAST_MODEL,
        },
      };
    });
  }, []);

  const handleVoiceSelect = useCallback(
    (presetId: string) => {
      stopVoicePreview();
      if (useElevenLabs) {
        const preset = PREMADE_VOICES.find((entry) => entry.id === presetId);
        if (!preset) return;
        setVoiceConfig((prev) => ({
          ...prev,
          provider: "elevenlabs",
          elevenlabs: {
            ...(prev.elevenlabs ?? {}),
            voiceId: preset.voiceId,
          },
        }));
        return;
      }
      const preset = EDGE_BACKUP_VOICES.find((entry) => entry.id === presetId);
      if (!preset) return;
      setVoiceConfig((prev) => ({
        ...prev,
        provider: "edge",
        edge: { ...(prev.edge ?? {}), voice: preset.voiceId },
      }));
    },
    [stopVoicePreview, useElevenLabs],
  );

  const handleSpeedChange = useCallback((next: number) => {
    setVoiceConfig((prev) => {
      if (prev.provider === "edge") {
        return { ...prev, edge: { ...(prev.edge ?? {}), rate: String(next) } };
      }
      return {
        ...prev,
        elevenlabs: { ...(prev.elevenlabs ?? {}), speed: next },
      };
    });
  }, []);

  const updatePrefs = useCallback((patch: Partial<VoicePrefs>) => {
    setPrefs((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleWakeWordToggle = useCallback((next: boolean) => {
    setWakeWordEnabled(next);
    saveWakeWordEnabled(next);
  }, []);

  // Mirror prefs to localStorage so capture hot paths read the new values
  // without waiting on the config round-trip (same dual-store pattern as
  // VoiceSectionMount).
  const mirrorPrefs = useCallback((next: VoicePrefs) => {
    if (next.vadAutoStopEnabled) {
      saveVadAutoStop({ silenceMs: next.silenceMs, speechRmsThreshold: 0.01 });
    }
    saveContinuousChatMode(next.continuous);
    saveOsIntentAutoStartConsent({
      voice: next.osIntentAutoStartVoice,
      transcription: next.osIntentAutoStartTranscription,
    });
  }, []);

  const ttsDirty =
    JSON.stringify(voiceConfig) !== JSON.stringify(savedVoiceConfig);
  const prefsDirty = JSON.stringify(prefs) !== JSON.stringify(savedPrefs);
  const dirty = ttsDirty || prefsDirty;

  const performSave = useCallback(async () => {
    if (!ttsDirty && !prefsDirty) return;
    const config = await client.getConfig();
    const messages = (config.messages ?? {}) as Record<string, unknown>;
    const updatedMessages: Record<string, unknown> = { ...messages };
    if (ttsDirty) updatedMessages[TTS_CONFIG_KEY] = voiceConfig;
    if (prefsDirty) updatedMessages[VOICE_PREFS_CONFIG_KEY] = prefs;
    await client.updateConfig({ messages: updatedMessages });
    if (ttsDirty) {
      dispatchWindowEvent(VOICE_CONFIG_UPDATED_EVENT, voiceConfig);
      setSavedVoiceConfig(voiceConfig);
    }
    if (prefsDirty) {
      mirrorPrefs(prefs);
      setSavedPrefs(prefs);
    }
  }, [mirrorPrefs, prefs, prefsDirty, ttsDirty, voiceConfig]);

  const { saving, saveError, saveSuccess, handleSave } = useSettingsSave({
    onSave: performSave,
    errorFallback: t("settings.voice.saveFailed", {
      defaultValue: "Failed to save voice settings.",
    }),
  });

  return (
    <SettingsStack>
      {/* Text-to-Speech */}
      <SettingsGroup
        title={t("settings.voice.ttsGroupTitle", {
          defaultValue: "Text-to-Speech",
        })}
        footer="Configure how Eliza speaks aloud."
      >
        <NuphySelectRow
          agentId="cloud-voice-tts-provider"
          label={t("settings.voice.provider", { defaultValue: "Provider" })}
          value={provider}
          onValueChange={handleProviderChange}
          options={[
            { value: "elevenlabs", label: "ElevenLabs" },
            { value: "edge", label: "Edge" },
          ]}
        />
        <NuphySelectRow
          agentId="cloud-voice-tts-voice"
          label={t("common.voice", { defaultValue: "Voice" })}
          value={visibleVoicePresetId ?? ""}
          options={voiceOptions}
          onValueChange={handleVoiceSelect}
          disabled={loading}
        />
        <NuphyActionButton
          agentId="cloud-voice-tts-test"
          label={t("settings.voice.testVoice", {
            defaultValue: "Test voice",
          })}
          agentLabel={voiceTesting ? "Stop voice preview" : "Test voice"}
          buttonLabel={
            voiceTesting ? (
              <VolumeX className="h-4 w-4" />
            ) : (
              <Volume2 className="h-4 w-4" />
            )
          }
          onActivate={voiceTesting ? stopVoicePreview : handlePreviewVoice}
          disabled={!activeVoicePreset?.previewUrl || loading}
          variant={voiceTesting ? "destructive" : "ghost"}
        />
        <NuphySliderRow
          agentId="cloud-voice-tts-speed"
          label={t("settings.voice.speed", { defaultValue: "Speed" })}
          value={speed}
          onValueChange={handleSpeedChange}
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={SPEED_STEP}
          unit="×"
        />
      </SettingsGroup>

      {/* Speech-to-Text */}
      <SettingsGroup
        title={t("settings.voice.sttGroupTitle", {
          defaultValue: "Speech-to-Text",
        })}
        footer="Configure how Eliza listens and transcribes."
      >
        <NuphySelectRow
          agentId="cloud-voice-stt-profile"
          label={t("settings.voice.voiceProfile", {
            defaultValue: "Voice profile",
          })}
          value={prefs.selectedVoiceProfileId}
          options={profileOptions}
          onValueChange={(id) => updatePrefs({ selectedVoiceProfileId: id })}
          disabled={profiles.length === 0}
        />
        <NuphySwitchRow
          agentId="cloud-voice-vad-autostop"
          label={t("settings.voice.vadAutoStop", {
            defaultValue: "VAD auto-stop",
          })}
          checked={prefs.vadAutoStopEnabled}
          onCheckedChange={(checked) =>
            updatePrefs({ vadAutoStopEnabled: checked })
          }
        />
        {prefs.vadAutoStopEnabled ? (
          <NuphySliderRow
            agentId="cloud-voice-silence-threshold"
            label={t("settings.voice.silenceThreshold", {
              defaultValue: "Silence threshold",
            })}
            value={prefs.silenceMs}
            onValueChange={(v) => updatePrefs({ silenceMs: v })}
            min={SILENCE_MIN_MS}
            max={SILENCE_MAX_MS}
            step={SILENCE_STEP_MS}
            unit="ms"
          />
        ) : null}
        <NuphySwitchRow
          agentId="cloud-voice-wake-word"
          label={t("settings.voice.wakeWord", { defaultValue: "Wake word" })}
          checked={wakeWordEnabled}
          onCheckedChange={handleWakeWordToggle}
        />
        <NuphyInputRow
          agentId="cloud-voice-wake-word-text"
          label={t("settings.voice.wakeWordText", { defaultValue: "Word" })}
          value={prefs.wakeWord}
          onValueChange={(word) => updatePrefs({ wakeWord: word })}
          placeholder={t("settings.voice.wakeWordPlaceholder", {
            defaultValue: "e.g. Hey Eliza",
          })}
          disabled={!wakeWordEnabled}
        />
      </SettingsGroup>

      {/* Conversation */}
      <SettingsGroup
        title={t("settings.voice.conversationGroupTitle", {
          defaultValue: "Conversation",
        })}
        footer="Control continuous and voice-triggered conversation modes."
      >
        <NuphySwitchRow
          agentId="cloud-voice-continuous-chat"
          label={t("settings.voice.continuousChat", {
            defaultValue: "Continuous chat",
          })}
          checked={prefs.continuous !== "off"}
          onCheckedChange={(checked) =>
            updatePrefs({ continuous: checked ? "vad-gated" : "off" })
          }
        />
        <NuphySwitchRow
          agentId="cloud-voice-intent-autostart-voice"
          label={t("settings.voice.intentAutoStartVoice", {
            defaultValue: "OS intent auto-start voice",
          })}
          checked={prefs.osIntentAutoStartVoice}
          onCheckedChange={(checked) =>
            updatePrefs({ osIntentAutoStartVoice: checked })
          }
        />
        <NuphySwitchRow
          agentId="cloud-voice-intent-autostart-transcription"
          label={t("settings.voice.intentAutoStartTranscription", {
            defaultValue: "OS intent auto-start transcription",
          })}
          checked={prefs.osIntentAutoStartTranscription}
          onCheckedChange={(checked) =>
            updatePrefs({ osIntentAutoStartTranscription: checked })
          }
        />
      </SettingsGroup>

      <SaveFooter
        dirty={dirty}
        saving={saving}
        saveError={saveError}
        saveSuccess={saveSuccess}
        onSave={() => void handleSave()}
      />
    </SettingsStack>
  );
}
