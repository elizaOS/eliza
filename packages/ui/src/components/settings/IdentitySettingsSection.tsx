import {
  Button,
  Input,
  SaveFooter,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@elizaos/ui";
import { Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client, type VoiceConfig } from "../../api";
import { dispatchWindowEvent, VOICE_CONFIG_UPDATED_EVENT } from "../../events";
import { useApp } from "../../state";
import { replaceNameTokens } from "../../utils/name-tokens";
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
import {
  SettingsField,
  SettingsFieldLabel,
  useSettingsSave,
} from "./settings-control-primitives";

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
    args.voiceConfig.provider ?? (args.useElevenLabs ? "elevenlabs" : "edge");

  if (provider === "edge") {
    return {
      ...args.voiceConfig,
      provider: "edge",
      edge: args.voiceConfig.edge ?? {},
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
  const {
    t,
    characterData,
    characterDraft,
    characterLoading,
    handleCharacterFieldInput,
    handleSaveCharacter,
    loadCharacter,
    elizaCloudConnected,
    elizaCloudVoiceProxyAvailable,
  } = useApp();

  const useElevenLabs = elizaCloudConnected || elizaCloudVoiceProxyAvailable;
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>({});
  const [savedVoiceConfig, setSavedVoiceConfig] = useState<VoiceConfig>({});
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [voiceTesting, setVoiceTesting] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const attemptedInitialCharacterLoadRef = useRef(false);

  const hasCharacterDraft = Object.keys(characterDraft).length > 0;

  useEffect(() => {
    if (
      attemptedInitialCharacterLoadRef.current ||
      characterLoading ||
      characterData ||
      hasCharacterDraft
    ) {
      return;
    }
    attemptedInitialCharacterLoadRef.current = true;
    void loadCharacter();
  }, [characterData, characterLoading, hasCharacterDraft, loadCharacter]);

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
            id: item.id,
            text: preset?.nameKey
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
          id: item.id,
          text: preset?.nameKey
            ? t(preset.nameKey, { defaultValue: preset.name })
            : (preset?.name ?? item.text),
          hint: preset?.hintKey
            ? t(preset.hintKey, { defaultValue: preset.hint })
            : preset?.hint,
        };
      }),
    }));
  }, [t, useElevenLabs]);

  const savedName =
    typeof characterData?.name === "string" ? characterData.name : "";
  const savedSystem =
    typeof characterData?.system === "string"
      ? replaceNameTokens(characterData.system, savedName)
      : "";
  const draftName =
    typeof characterDraft.name === "string" ? characterDraft.name : "";
  const draftSystem =
    typeof characterDraft.system === "string" ? characterDraft.system : "";
  const characterDirty = draftName !== savedName || draftSystem !== savedSystem;
  const voiceDirty =
    resolveEditableVoiceSelectionKey(voiceConfig) !==
    resolveEditableVoiceSelectionKey(savedVoiceConfig);
  const dirty = characterDirty || voiceDirty;
  const showCharacterBootstrapping =
    !characterData &&
    !hasCharacterDraft &&
    (characterLoading || !attemptedInitialCharacterLoadRef.current);

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
    if (!dirty) return;
    if (characterDirty) {
      await handleSaveCharacter();
    }
    if (voiceDirty) {
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
    }
  }, [
    characterDirty,
    dirty,
    handleSaveCharacter,
    useElevenLabs,
    voiceConfig,
    voiceDirty,
  ]);

  const { saving, saveError, saveSuccess, handleSave } = useSettingsSave({
    onSave: performSave,
    errorFallback: t("settings.identity.saveFailed", {
      defaultValue: "Failed to save identity settings.",
    }),
  });

  return (
    <div className="flex flex-col gap-5">
      {showCharacterBootstrapping ? (
        <div className="rounded-2xl border border-border/60 bg-card/92 px-4 py-6 text-center text-xs text-muted shadow-sm">
          {t("settings.identity.loading", {
            defaultValue: "Loading identity settings…",
          })}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <SettingsField className="min-w-0">
          <SettingsFieldLabel htmlFor="settings-identity-name">
            {t("common.name", { defaultValue: "Name" })}
          </SettingsFieldLabel>
          <Input
            id="settings-identity-name"
            type="text"
            value={draftName}
            placeholder={t("startupshell.AgentName", {
              defaultValue: "Agent name",
            })}
            onChange={(event) =>
              handleCharacterFieldInput("name", event.target.value)
            }
            className="rounded-xl border-border/60 bg-card/80"
          />
        </SettingsField>

        <SettingsField className="min-w-0">
          <SettingsFieldLabel id="settings-identity-voice-label">
            {t("common.voice", { defaultValue: "Voice" })}
          </SettingsFieldLabel>
          <div className="flex items-center gap-2">
            <Select
              value={visibleVoicePresetId ?? undefined}
              onValueChange={(value) => handleVoiceSelect(value)}
            >
              <SelectTrigger
                aria-labelledby="settings-identity-voice-label"
                className="min-w-0 flex-1 h-11 rounded-xl border-border/60 bg-card/80 px-3 text-sm shadow-none"
              >
                <SelectValue
                  placeholder={t("charactereditor.SelectAVoice", {
                    defaultValue: "Select a voice",
                  })}
                />
              </SelectTrigger>
              <SelectContent className="border-border/60 bg-bg/92 shadow-2xl backdrop-blur-md">
                {voiceGroups.map((group) => (
                  <SelectGroup key={group.label}>
                    <SelectLabel className="px-2.5 py-1 text-2xs font-semibold text-muted">
                      {group.label}
                    </SelectLabel>
                    {group.items.map((item) => (
                      <SelectItem
                        key={item.id}
                        value={item.id}
                        textValue={item.text}
                      >
                        <div className="flex w-full items-center justify-between gap-2">
                          <span className="font-semibold">{item.text}</span>
                          {item.hint ? (
                            <span className="text-muted text-xs">
                              {item.hint}
                            </span>
                          ) : null}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant={voiceTesting ? "destructive" : "ghost"}
              size="icon"
              className="h-10 w-10 shrink-0 rounded-full"
              onClick={voiceTesting ? stopVoicePreview : handlePreviewVoice}
              aria-label={
                voiceTesting
                  ? t("settings.identity.stopVoicePreview", {
                      defaultValue: "Stop voice preview",
                    })
                  : t("settings.identity.previewVoice", {
                      defaultValue: "Preview voice",
                    })
              }
              disabled={!activeVoicePreset?.previewUrl || voiceLoading}
            >
              {voiceTesting ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </Button>
          </div>
        </SettingsField>
      </div>

      <SettingsField>
        <SettingsFieldLabel htmlFor="settings-identity-system-prompt">
          {t("settings.identity.systemPromptLabel", {
            defaultValue: "System prompt",
          })}
        </SettingsFieldLabel>
        <Textarea
          id="settings-identity-system-prompt"
          value={draftSystem}
          rows={10}
          maxLength={100000}
          placeholder={t("charactereditor.SystemPromptPlaceholder", {
            defaultValue: "Write in first person...",
          })}
          onChange={(event) =>
            handleCharacterFieldInput("system", event.target.value)
          }
          className="min-h-[14rem] rounded-xl border-border/60 bg-card/80 font-mono text-xs leading-relaxed"
        />
      </SettingsField>

      <SaveFooter
        dirty={dirty}
        saving={saving}
        saveError={saveError}
        saveSuccess={saveSuccess}
        onSave={() => void handleSave()}
      />
    </div>
  );
}
