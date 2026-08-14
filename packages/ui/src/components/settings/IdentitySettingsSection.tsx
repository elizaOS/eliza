/**
 * Settings → "Basics" section (the `identity` section id). Owns the agent's
 * voice pick — TTS provider, model, and voice preset with in-panel test
 * playback. When Eliza Cloud is connected (or the voice proxy is available) the
 * ElevenLabs voice groups are offered; otherwise it falls back to the edge/
 * premade voices. The agent's name and personality (system prompt) live in the
 * Character view, not here.
 */

import { Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client, type VoiceConfig } from "../../api";
import { dispatchWindowEvent, VOICE_CONFIG_UPDATED_EVENT } from "../../events";
import { useAppSelectorShallow } from "../../state";
import {
  EDGE_BACKUP_VOICES,
  hasConfiguredApiKey,
  PREMADE_VOICES,
  sanitizeApiKey,
} from "../../voice/types";
import {
  DEFAULT_ELEVEN_FAST_MODEL,
  EDGE_VOICE_GROUPS,
  ELEVENLABS_VOICE_GROUPS,
} from "../character/character-voice-config";
import { SaveFooter } from "../ui/save-footer";
import { SettingsSelectRow } from "./settings-agent-rows";
import { useSettingsSave } from "./settings-control-primitives.hooks";
import { SettingsGroup, SettingsStack } from "./settings-layout";

function resolveEditableVoiceSelectionKey(config: VoiceConfig | null): string {
  const elevenLabsVoiceId =
    typeof config?.elevenlabs?.voiceId === "string"
      ? config.elevenlabs.voiceId.trim()
      : "";
  const edgeVoiceId =
    typeof config?.edge?.voice === "string" ? config.edge.voice.trim() : "";
  const provider =
    config?.provider ??
    (edgeVoiceId && !elevenLabsVoiceId ? "edge" : "elevenlabs");
  return `${provider}:${provider === "edge" ? edgeVoiceId : elevenLabsVoiceId}`;
}

function resolveVisibleVoicePresetId(
  config: VoiceConfig,
  useElevenLabs: boolean,
): string | null {
  if (useElevenLabs) {
    const elevenLabsVoiceId =
      typeof config.elevenlabs?.voiceId === "string"
        ? config.elevenlabs.voiceId.trim()
        : "";
    if (!elevenLabsVoiceId) return null;
    return (
      PREMADE_VOICES.find((preset) => preset.voiceId === elevenLabsVoiceId)
        ?.id ?? null
    );
  }

  const edgeVoiceId =
    typeof config.edge?.voice === "string" ? config.edge.voice.trim() : "";
  if (!edgeVoiceId) return null;
  return (
    EDGE_BACKUP_VOICES.find((preset) => preset.voiceId === edgeVoiceId)?.id ??
    null
  );
}

function normalizeVoiceConfigForSave(args: {
  voiceConfig: VoiceConfig;
  useElevenLabs: boolean;
}): VoiceConfig {
  const provider =
    args.voiceConfig.provider ?? (args.useElevenLabs ? "eliza-cloud" : "edge");

  if (provider === "edge") {
    return {
      ...args.voiceConfig,
      provider: "edge",
      edge: args.voiceConfig.edge ?? {},
    };
  }

  if (provider === "eliza-cloud") {
    return {
      ...args.voiceConfig,
      provider: "eliza-cloud",
      mode: undefined,
    };
  }

  if (provider === "local-inference" || provider === "robot-voice") {
    return {
      ...args.voiceConfig,
      provider,
      mode: undefined,
    };
  }

  const hasElevenLabsApiKey = hasConfiguredApiKey(
    args.voiceConfig.elevenlabs?.apiKey,
  );
  const defaultVoiceMode =
    typeof args.voiceConfig.mode === "string"
      ? args.voiceConfig.mode
      : args.useElevenLabs && !hasElevenLabsApiKey
        ? "cloud"
        : "own-key";
  const normalized = {
    ...(args.voiceConfig.elevenlabs ?? {}),
    modelId: args.voiceConfig.elevenlabs?.modelId ?? DEFAULT_ELEVEN_FAST_MODEL,
  };
  const sanitizedKey = sanitizeApiKey(normalized.apiKey);
  if (sanitizedKey) normalized.apiKey = sanitizedKey;
  else delete normalized.apiKey;

  return {
    ...args.voiceConfig,
    provider: "elevenlabs",
    mode: defaultVoiceMode,
    elevenlabs: normalized,
  };
}

export function IdentitySettingsSection() {
  const { t, elizaCloudConnected, elizaCloudVoiceProxyAvailable } =
    useAppSelectorShallow((s) => ({
      t: s.t,
      elizaCloudConnected: s.elizaCloudConnected,
      elizaCloudVoiceProxyAvailable: s.elizaCloudVoiceProxyAvailable,
    }));

  const useElevenLabs = elizaCloudConnected || elizaCloudVoiceProxyAvailable;
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>({});
  const [savedVoiceConfig, setSavedVoiceConfig] = useState<VoiceConfig>({});
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [voiceTesting, setVoiceTesting] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setVoiceLoading(true);
      try {
        const config = await client.getConfig();
        const messages = (config.messages ?? {}) as Record<string, unknown>;
        const tts = (messages.tts as VoiceConfig | undefined) ?? {};
        if (!cancelled) {
          setVoiceConfig(tts);
          setSavedVoiceConfig(tts);
        }
      } catch {
        if (!cancelled) {
          setVoiceConfig({});
          setSavedVoiceConfig({});
        }
      } finally {
        if (!cancelled) {
          setVoiceLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (!audioRef.current) return;
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    };
  }, []);

  const stopVoicePreview = useCallback(() => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    audioRef.current.currentTime = 0;
    audioRef.current = null;
    setVoiceTesting(false);
  }, []);

  const visibleVoicePresetId = useMemo(
    () => resolveVisibleVoicePresetId(voiceConfig, useElevenLabs),
    [useElevenLabs, voiceConfig],
  );

  const activeVoicePreset = useMemo(() => {
    const presets = useElevenLabs ? PREMADE_VOICES : EDGE_BACKUP_VOICES;
    return presets.find((preset) => preset.id === visibleVoicePresetId) ?? null;
  }, [useElevenLabs, visibleVoicePresetId]);

  const voiceGroups = useMemo(() => {
    if (useElevenLabs) {
      return ELEVENLABS_VOICE_GROUPS.map((group) => ({
        label: t(group.labelKey, { defaultValue: group.defaultLabel }),
        items: group.items.map((item) => {
          const preset = PREMADE_VOICES.find((entry) => entry.id === item.id);
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
    }

    return EDGE_VOICE_GROUPS.map((group) => ({
      label: t(group.labelKey, { defaultValue: group.defaultLabel }),
      items: group.items.map((item) => {
        const preset = EDGE_BACKUP_VOICES.find((entry) => entry.id === item.id);
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
    () => voiceGroups.flatMap((group) => group.items.map((item) => item.value)),
    [voiceGroups],
  );

  const voiceDirty =
    resolveEditableVoiceSelectionKey(voiceConfig) !==
    resolveEditableVoiceSelectionKey(savedVoiceConfig);
  const dirty = voiceDirty;

  const handleVoiceSelect = useCallback(
    (presetId: string) => {
      stopVoicePreview();
      if (useElevenLabs) {
        const preset = PREMADE_VOICES.find((entry) => entry.id === presetId);
        if (!preset) return;
        setVoiceConfig((prev) => {
          const existing =
            typeof prev.elevenlabs === "object" ? prev.elevenlabs : {};
          return {
            ...prev,
            provider: "elevenlabs",
            elevenlabs: {
              ...existing,
              voiceId: preset.voiceId,
            },
          };
        });
        return;
      }

      const preset = EDGE_BACKUP_VOICES.find((entry) => entry.id === presetId);
      if (!preset) return;
      setVoiceConfig((prev) => {
        const existingEdge = typeof prev.edge === "object" ? prev.edge : {};
        return {
          ...prev,
          provider: "edge",
          edge: {
            ...existingEdge,
            voice: preset.voiceId,
          },
        };
      });
    },
    [stopVoicePreview, useElevenLabs],
  );

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

  const performSave = useCallback(async () => {
    if (!voiceDirty) return;
    const config = await client.getConfig();
    const messages = (config.messages ?? {}) as Record<string, unknown>;
    const normalizedVoiceConfig = normalizeVoiceConfigForSave({
      voiceConfig,
      useElevenLabs,
    });
    await client.updateConfig({
      messages: {
        ...messages,
        tts: normalizedVoiceConfig,
      },
    });
    dispatchWindowEvent(VOICE_CONFIG_UPDATED_EVENT, normalizedVoiceConfig);
    setSavedVoiceConfig(normalizedVoiceConfig);
  }, [useElevenLabs, voiceConfig, voiceDirty]);

  const { saving, saveError, saveSuccess, handleSave } = useSettingsSave({
    onSave: performSave,
    errorFallback: t("settings.identity.saveFailed", {
      defaultValue: "Failed to save identity settings.",
    }),
  });

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("settings.identity.groupTitle", { defaultValue: "Identity" })}
      >
        <SettingsSelectRow
          agentId="identity-voice"
          label={t("common.voice", { defaultValue: "Voice" })}
          agentLabel={t("common.voice", { defaultValue: "Voice" })}
          placeholder={t("charactereditor.SelectAVoice", {
            defaultValue: "Select a voice",
          })}
          value={visibleVoicePresetId ?? ""}
          optionGroups={voiceGroups}
          onValueChange={handleVoiceSelect}
          trailingAction={{
            node: voiceTesting ? (
              <VolumeX className="h-4 w-4" />
            ) : (
              <Volume2 className="h-4 w-4" />
            ),
            onClick: voiceTesting ? stopVoicePreview : handlePreviewVoice,
            disabled: !activeVoicePreset?.previewUrl || voiceLoading,
          }}
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
