/**
 * VoiceConfigView — TTS/STT provider selection and configuration.
 *
 * Similar to MediaSettingsSection pattern:
 *   - Provider selection (ElevenLabs, Edge TTS, etc.)
 *   - API key inputs where needed
 *   - Voice preset selection
 *   - Test functionality
 */

import { Button, Input } from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  client,
  type VoiceConfig,
  type VoiceMode,
  type VoiceProvider,
} from "../api";
import { getSwabblePlugin, type SwabbleConfig } from "../bridge/native-plugins";
import { dispatchWindowEvent, VOICE_CONFIG_UPDATED_EVENT } from "../events";
import { useTimeout } from "../hooks";
import { useApp } from "../state";
import { PREMADE_VOICES, sanitizeApiKey, VOICE_PROVIDERS } from "../voice";
import {
  CloudConnectionStatus,
  CloudSourceModeToggle,
} from "./CloudSourceControls";
import { ConfigSaveFooter } from "./ConfigSaveFooter";

const DEFAULT_ELEVEN_FAST_MODEL = "eleven_flash_v2_5";

const MODEL_SIZES: Array<{
  id: NonNullable<SwabbleConfig["modelSize"]>;
  hint: string;
}> = [
  { id: "tiny", hint: "(faster)" },
  { id: "base", hint: "(recommended)" },
  { id: "small", hint: "" },
  { id: "medium", hint: "(accurate)" },
  { id: "large", hint: "(accurate)" },
];

function WakeWordSection({
  serverConfig,
}: {
  serverConfig?: Partial<SwabbleConfig> | null;
}) {
  const { t } = useApp();
  const [triggers, setTriggers] = useState<string[]>(["eliza"]);
  const [triggerInput, setTriggerInput] = useState("");
  const [sensitivity, setSensitivity] = useState(0.45);
  const [modelSize, setModelSize] =
    useState<NonNullable<SwabbleConfig["modelSize"]>>("base");
  const [audioLevel, setAudioLevel] = useState(0);
  const [enabled, setEnabled] = useState(false);

  // Load initial state from Swabble on mount
  useEffect(() => {
    void (async () => {
      try {
        const swabble = getSwabblePlugin();
        const [{ config }, { listening }] = await Promise.all([
          swabble.getConfig(),
          swabble.isListening(),
        ]);
        // Use plugin config if available, fall back to server-persisted config
        const resolved = config ?? serverConfig ?? null;
        if (resolved) {
          if (resolved.triggers?.length) setTriggers(resolved.triggers);
          if (resolved.minPostTriggerGap != null)
            setSensitivity(resolved.minPostTriggerGap);
          if (resolved.modelSize) setModelSize(resolved.modelSize);
        }
        setEnabled(listening);
      } catch {
        // Plugin not available on this platform — silently ignore
      }
    })();
  }, [serverConfig]);

  // Subscribe to audio level events
  useEffect(() => {
    let handle: { remove: () => Promise<void> } | null = null;
    void (async () => {
      try {
        handle = await getSwabblePlugin().addListener(
          "audioLevel",
          (evt: { level: number }) => {
            setAudioLevel(evt.level);
          },
        );
      } catch {
        // Not available
      }
    })();
    return () => {
      if (handle) void handle.remove();
    };
  }, []);

  const buildConfig = useCallback(
    (): SwabbleConfig => ({
      triggers,
      minPostTriggerGap: sensitivity,
      modelSize,
    }),
    [triggers, sensitivity, modelSize],
  );

  const handleTriggersChange = useCallback(async (next: string[]) => {
    setTriggers(next);
    try {
      await getSwabblePlugin().updateConfig({ config: { triggers: next } });
    } catch {
      // Ignore
    }
  }, []);

  const addTrigger = useCallback(
    (raw: string) => {
      const val = raw.trim().toLowerCase().replace(/,/g, "");
      if (!val || triggers.includes(val)) return;
      void handleTriggersChange([...triggers, val]);
    },
    [triggers, handleTriggersChange],
  );

  const removeTrigger = useCallback(
    (t: string) => {
      if (triggers.length <= 1) return;
      void handleTriggersChange(triggers.filter((x) => x !== t));
    },
    [triggers, handleTriggersChange],
  );

  const handleSensitivityChange = useCallback(async (val: number) => {
    setSensitivity(val);
    try {
      await getSwabblePlugin().updateConfig({
        config: { minPostTriggerGap: val },
      });
    } catch {
      // Ignore
    }
  }, []);

  const handleModelSizeChange = useCallback(
    async (size: NonNullable<SwabbleConfig["modelSize"]>) => {
      setModelSize(size);
      try {
        await getSwabblePlugin().updateConfig({ config: { modelSize: size } });
      } catch {
        // Ignore
      }
    },
    [],
  );

  const handleToggle = useCallback(async () => {
    try {
      if (enabled) {
        await getSwabblePlugin().stop();
        setEnabled(false);
      } else {
        const result = await getSwabblePlugin().start({
          config: buildConfig(),
        });
        if (result.started) setEnabled(true);
      }
    } catch {
      // Ignore
    }
  }, [enabled, buildConfig]);

  return (
    <div className="flex flex-col gap-3 pt-4 border-t border-[var(--border)]">
      {/* Subsection header + enable toggle */}
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-[var(--muted)]">
          {t("voiceconfigview.WakeWord")}
        </div>
        <button
          type="button"
          onClick={() => void handleToggle()}
          className={`relative inline-flex h-5 w-9 cursor-pointer items-center rounded-full transition-colors ${
            enabled ? "bg-[var(--accent)]" : "bg-[var(--border)]"
          }`}
          aria-label={enabled ? "Disable wake word" : "Enable wake word"}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {/* Trigger tag input */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold">
          {t("voiceconfigview.Triggers")}
        </span>
        <div className="flex flex-wrap gap-1 p-1.5 border border-[var(--border)] bg-[var(--card)] min-h-[2rem]">
          {triggers.map((t) => (
            <span
              key={t}
              className="flex items-center gap-1 rounded-full border border-[var(--accent)] bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] text-[var(--text)]"
            >
              {t}
              {triggers.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="settings-compact-button settings-icon-button leading-none hover:bg-transparent hover:opacity-70 cursor-pointer h-4 w-4 ml-1"
                  onClick={() => removeTrigger(t)}
                  aria-label={`Remove trigger "${t}"`}
                >
                  ×
                </Button>
              )}
            </span>
          ))}
          <Input
            type="text"
            className="flex-1 min-w-[80px] h-6 px-1 text-xs bg-transparent border-0 focus-visible:ring-0 shadow-none"
            placeholder={t("voiceconfigview.AddTrigger")}
            value={triggerInput}
            onChange={(e) => setTriggerInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTrigger(triggerInput);
                setTriggerInput("");
              }
            }}
          />
        </div>
        <div className="text-[10px] text-[var(--muted)]">
          {t("voiceconfigview.PressEnterOrComma")}
        </div>
      </div>

      {/* Sensitivity slider */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold">
            {t("voiceconfigview.WakeSensitivity")}
          </span>
          <span className="text-[10px] text-[var(--muted)]">
            {sensitivity.toFixed(2)}s
          </span>
        </div>
        <input
          type="range"
          min={0.1}
          max={2.0}
          step={0.05}
          value={sensitivity}
          className="w-full"
          style={{ accentColor: "var(--accent)" }}
          onChange={(e) =>
            void handleSensitivityChange(parseFloat(e.target.value))
          }
        />
        <div className="text-[10px] text-[var(--muted)]">
          {t("voiceconfigview.LowerMoreSensiti")}
        </div>
      </div>

      {/* Model size buttons */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold">
          {t("voiceconfigview.ModelSize")}
        </span>
        <div className="flex gap-1.5">
          {MODEL_SIZES.map((m) => {
            const active = modelSize === m.id;
            return (
              <Button
                key={m.id}
                variant={active ? "default" : "outline"}
                size="sm"
                className="flex-1 h-auto flex-col py-1.5"
                onClick={() => void handleModelSizeChange(m.id)}
              >
                <div className="font-semibold">{m.id}</div>
                {m.hint && (
                  <div className="text-[10px] opacity-70 mt-0.5">{m.hint}</div>
                )}
              </Button>
            );
          })}
        </div>
      </div>

      {/* Audio level meter */}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold">
          {t("voiceconfigview.Microphone")}
        </span>
        <div className="h-1.5 w-full bg-[var(--border)] overflow-hidden">
          <div
            className="h-full bg-green-500 transition-all duration-75"
            style={{ width: `${Math.min(audioLevel * 100, 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

export function VoiceConfigView() {
  const { setTimeout } = useTimeout();

  const { t } = useApp();
  const { elizaCloudConnected } = useApp();
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>({});
  const [swabbleServerConfig, setSwabbleServerConfig] =
    useState<Partial<SwabbleConfig> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Load config on mount
  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const cfg = await client.getConfig();
        const messages = cfg.messages as
          | Record<string, Record<string, unknown>>
          | undefined;
        const tts = messages?.tts as VoiceConfig | undefined;
        if (tts) {
          setVoiceConfig(tts);
        }
        const swabble = messages?.swabble as Partial<SwabbleConfig> | undefined;
        if (swabble) {
          setSwabbleServerConfig(swabble);
        }
      } catch {
        // Ignore errors
      }
      setLoading(false);
    })();
  }, []);

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const currentProvider = voiceConfig.provider ?? "elevenlabs";
  const currentMode: VoiceMode = voiceConfig.mode ?? "own-key";
  const providerInfo = VOICE_PROVIDERS.find((p) => p.id === currentProvider);
  const isConfigured =
    currentMode === "cloud"
      ? elizaCloudConnected
      : currentProvider !== "elevenlabs"
        ? true
        : Boolean(voiceConfig.elevenlabs?.apiKey);

  const handleProviderChange = useCallback((provider: VoiceProvider) => {
    setVoiceConfig((prev) => ({ ...prev, provider }));
    setDirty(true);
  }, []);

  const handleModeChange = useCallback((mode: VoiceMode) => {
    setVoiceConfig((prev) => ({ ...prev, mode }));
    setDirty(true);
  }, []);

  const handleApiKeyChange = useCallback((apiKey: string) => {
    setVoiceConfig((prev) => ({
      ...prev,
      elevenlabs: { ...prev.elevenlabs, apiKey: apiKey || undefined },
    }));
    setDirty(true);
  }, []);

  const handleVoiceSelect = useCallback((voiceId: string) => {
    setVoiceConfig((prev) => ({
      ...prev,
      elevenlabs: { ...prev.elevenlabs, voiceId },
    }));
    setDirty(true);
  }, []);

  const handleTestVoice = useCallback((previewUrl: string) => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setTesting(true);
    const audio = new Audio(previewUrl);
    audioRef.current = audio;
    audio.onended = () => setTesting(false);
    audio.onerror = () => setTesting(false);
    audio.play().catch(() => setTesting(false));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const cfg = await client.getConfig();
      const messages = (cfg.messages ?? {}) as Record<string, unknown>;
      const provider = voiceConfig.provider ?? "elevenlabs";
      const normalizedElevenLabs =
        provider === "elevenlabs"
          ? {
              ...voiceConfig.elevenlabs,
              modelId:
                voiceConfig.elevenlabs?.modelId ?? DEFAULT_ELEVEN_FAST_MODEL,
            }
          : voiceConfig.elevenlabs;
      const sanitizedKey = sanitizeApiKey(normalizedElevenLabs?.apiKey);
      if (normalizedElevenLabs) {
        if (sanitizedKey) normalizedElevenLabs.apiKey = sanitizedKey;
        else delete normalizedElevenLabs.apiKey;
      }
      const normalizedVoiceConfig: VoiceConfig = {
        ...voiceConfig,
        provider,
        mode:
          provider === "elevenlabs"
            ? (voiceConfig.mode ?? "own-key")
            : undefined,
        elevenlabs: normalizedElevenLabs,
      };
      // Also persist swabble (wake word) config — fall back to server config
      // if the plugin isn't available on this platform (e.g. Electrobun).
      let swabbleCfg: Partial<SwabbleConfig> | undefined;
      try {
        const { config: sc } = await getSwabblePlugin().getConfig();
        if (sc) swabbleCfg = sc;
      } catch {
        // Not available on this platform
      }
      if (!swabbleCfg && swabbleServerConfig) {
        swabbleCfg = swabbleServerConfig;
      }

      await client.updateConfig({
        messages: {
          ...messages,
          tts: normalizedVoiceConfig,
          ...(swabbleCfg ? { swabble: swabbleCfg } : {}),
        },
      });
      dispatchWindowEvent(VOICE_CONFIG_UPDATED_EVENT, normalizedVoiceConfig);
      setSaveSuccess(true);
      setDirty(false);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    }
    setSaving(false);
  }, [swabbleServerConfig, voiceConfig, setTimeout]);

  if (loading) {
    return (
      <div className="py-4 text-center text-[var(--muted)] text-xs">
        {t("voiceconfigview.LoadingVoiceConfig")}
      </div>
    );
  }

  const selectedVoiceId = voiceConfig.elevenlabs?.voiceId;
  const selectedPreset = PREMADE_VOICES.find(
    (p) => p.voiceId === selectedVoiceId,
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Provider selection */}
      <div className="flex flex-col gap-2">
        <div className="text-xs font-semibold text-[var(--muted)]">
          {t("voiceconfigview.TTSProvider")}
        </div>
        <div className="flex gap-2">
          {VOICE_PROVIDERS.map((p) => {
            const active = currentProvider === p.id;
            return (
              <Button
                key={p.id}
                variant={active ? "default" : "outline"}
                size="sm"
                className="flex-1 h-auto flex-col py-2"
                onClick={() => handleProviderChange(p.id)}
              >
                <div className="font-semibold">{p.label}</div>
                <div className="text-[10px] opacity-70 mt-0.5">{p.hint}</div>
              </Button>
            );
          })}
        </div>
      </div>

      {/* Status */}
      <div className="flex items-center justify-between py-2 px-3 border border-[var(--border)] bg-[var(--bg-muted)]">
        <span className="text-xs">
          {currentProvider === "elevenlabs"
            ? `ElevenLabs — ${currentMode === "cloud" ? t("voiceconfigview.ServedViaElizaCloud") : t("voiceconfigview.RequiresApiKey")}`
            : `${providerInfo?.label} — ${t("voiceconfigview.NoApiKeyNeeded")}`}
        </span>
        <span
          className={`rounded-full border px-1.5 py-0.5 text-[10px] ${
            isConfigured
              ? "border-green-600 bg-green-600/10 text-[var(--text)]"
              : "border-[var(--warn)] bg-[var(--warn-subtle)] text-[var(--text)]"
          }`}
        >
          {isConfigured
            ? t("mediasettingssection.Configured")
            : t("mediasettingssection.NeedsSetup")}
        </span>
      </div>

      {/* ElevenLabs settings */}
      {currentProvider === "elevenlabs" && (
        <div className="flex flex-col gap-3">
          {/* API source mode */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-[var(--muted)]">
              {t("voiceconfigview.APISource")}
            </span>
            <CloudSourceModeToggle
              mode={currentMode}
              onChange={handleModeChange}
            />
          </div>

          {/* Cloud mode status */}
          {currentMode === "cloud" && (
            <CloudConnectionStatus
              connected={elizaCloudConnected}
              disconnectedText={t("elizaclouddashboard.ElizaCloudNotConnected")}
            />
          )}

          {/* API Key */}
          {currentMode === "own-key" && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold">
                {t("voiceconfigview.ElevenLabsAPIKey")}
              </span>
              <Input
                type="password"
                className="bg-card text-xs"
                placeholder={
                  voiceConfig.elevenlabs?.apiKey
                    ? t("mediasettingssection.ApiKeySetLeaveBlank")
                    : t("mediasettingssection.EnterApiKey")
                }
                onChange={(e) => handleApiKeyChange(e.target.value)}
              />
              <div className="text-[10px] text-[var(--muted)]">
                {t("voiceconfigview.GetYourKeyAt")}{" "}
                <a
                  href="https://elevenlabs.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--text)] underline decoration-[var(--accent)] underline-offset-2 hover:opacity-80"
                >
                  {t("voiceconfigview.elevenlabsIo")}
                </a>
              </div>
              <div className="text-[10px] text-[var(--muted)]">
                {t("voiceconfigview.FastPathDefaultE")}
                {DEFAULT_ELEVEN_FAST_MODEL}`).
              </div>
            </div>
          )}

          {/* Voice presets */}
          <div className="flex flex-col gap-2">
            <div className="text-xs font-semibold">
              {t("voiceconfigview.Voice")}
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {PREMADE_VOICES.map((preset) => {
                const active = selectedVoiceId === preset.voiceId;
                return (
                  <Button
                    key={preset.id}
                    variant={active ? "default" : "outline"}
                    size="sm"
                    className="h-auto flex-col items-start py-1.5 px-2 text-left"
                    onClick={() => handleVoiceSelect(preset.voiceId)}
                  >
                    <div className="font-semibold truncate w-full">
                      {preset.name}
                    </div>
                    <div className="text-[10px] opacity-70 truncate w-full">
                      {preset.hint}
                    </div>
                  </Button>
                );
              })}
            </div>
          </div>

          {/* Test voice */}
          {selectedPreset && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="font-semibold"
                disabled={testing}
                onClick={() => handleTestVoice(selectedPreset.previewUrl)}
              >
                {testing
                  ? t("voiceconfigview.Playing")
                  : t("voiceconfigview.TestVoice", {
                      name: selectedPreset.name,
                    })}
              </Button>
              {testing && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (audioRef.current) {
                      audioRef.current.pause();
                      setTesting(false);
                    }
                  }}
                >
                  {t("voiceconfigview.Stop")}
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Edge TTS settings */}
      {currentProvider === "edge" && (
        <div className="py-2 px-3 border border-[var(--border)] bg-[var(--bg-muted)] text-xs text-[var(--muted)]">
          {t("voiceconfigview.EdgeTTSUsesMicros")}
        </div>
      )}

      {/* Simple voice settings */}
      {currentProvider === "simple-voice" && (
        <div className="py-2 px-3 border border-[var(--border)] bg-[var(--bg-muted)] text-xs text-[var(--muted)]">
          {t("voiceconfigview.SimpleVoiceUsesYo")}
        </div>
      )}

      {/* Wake Word subsection */}
      <WakeWordSection serverConfig={swabbleServerConfig} />

      <ConfigSaveFooter
        dirty={dirty}
        saving={saving}
        saveError={saveError}
        saveSuccess={saveSuccess}
        onSave={() => void handleSave()}
      />
    </div>
  );
}
