import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  SaveFooter,
  Switch,
} from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  client,
  type VoiceConfig,
  type VoiceMode,
  type VoiceProvider,
} from "../../api";
import { invokeDesktopBridgeRequest, isElectrobunRuntime } from "../../bridge";
import {
  getSwabblePlugin,
  type SwabbleConfig,
} from "../../bridge/native-plugins";
import { dispatchWindowEvent, VOICE_CONFIG_UPDATED_EVENT } from "../../events";
import { useApp } from "../../state";
import type { DesktopClickAuditItem } from "../../utils";
import {
  hasConfiguredApiKey,
  PREMADE_VOICES,
  sanitizeApiKey,
  VOICE_PROVIDERS,
} from "../../voice";
import {
  CloudConnectionStatus,
  CloudSourceModeToggle,
} from "../cloud/CloudSourceControls";
import { useSettingsSave } from "./settings-control-primitives";

const DEFAULT_ELEVEN_FAST_MODEL = "eleven_flash_v2_5";

const MODEL_SIZES: Array<{
  id: NonNullable<SwabbleConfig["modelSize"]>;
  hintKey: string;
}> = [
  { id: "tiny", hintKey: "voiceconfigview.hintFaster" },
  { id: "base", hintKey: "voiceconfigview.hintRecommended" },
  { id: "small", hintKey: "" },
  { id: "medium", hintKey: "voiceconfigview.hintAccurate" },
  { id: "large", hintKey: "voiceconfigview.hintAccurate" },
];

export const DESKTOP_TALKMODE_CLICK_AUDIT: readonly DesktopClickAuditItem[] = [
  {
    id: "voice-talkmode-refresh",
    entryPoint: "settings:voice",
    label: "Refresh Talk Mode",
    expectedAction:
      "Refresh talk mode state, speaking status, and whisper availability.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "voice-talkmode-start-stop",
    entryPoint: "settings:voice",
    label: "Start/Stop Talk Mode",
    expectedAction: "Start or stop desktop talk mode.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "voice-talkmode-speak",
    entryPoint: "settings:voice",
    label: "Speak Test Phrase",
    expectedAction: "Send a test phrase to talk mode speech output.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "voice-talkmode-stop-speaking",
    entryPoint: "settings:voice",
    label: "Stop Speaking",
    expectedAction: "Stop current desktop speech output.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
] as const;

export function DesktopTalkModePanel() {
  const desktopRuntime = isElectrobunRuntime();
  const [loading, setLoading] = useState(desktopRuntime);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { t } = useApp();
  const [phrase, setPhrase] = useState(t("voiceconfigview.testPhrase"));
  const [panelState, setPanelState] = useState<{
    state: string;
    enabled: boolean;
    speaking: boolean;
    whisperAvailable: boolean;
    whisperModel?: string;
  }>({
    state: "idle",
    enabled: false,
    speaking: false,
    whisperAvailable: false,
  });

  const refresh = useCallback(async () => {
    if (!desktopRuntime) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const [state, enabled, speaking, whisperInfo] = await Promise.all([
        invokeDesktopBridgeRequest<{ state: string }>({
          rpcMethod: "talkmodeGetState",
          ipcChannel: "talkmode:getState",
        }),
        invokeDesktopBridgeRequest<{ enabled: boolean }>({
          rpcMethod: "talkmodeIsEnabled",
          ipcChannel: "talkmode:isEnabled",
        }),
        invokeDesktopBridgeRequest<{ speaking: boolean }>({
          rpcMethod: "talkmodeIsSpeaking",
          ipcChannel: "talkmode:isSpeaking",
        }),
        invokeDesktopBridgeRequest<{ available: boolean; modelSize?: string }>({
          rpcMethod: "talkmodeGetWhisperInfo",
          ipcChannel: "talkmode:getWhisperInfo",
        }),
      ]);
      setPanelState({
        state: state?.state ?? "idle",
        enabled: enabled?.enabled ?? false,
        speaking: speaking?.speaking ?? false,
        whisperAvailable: whisperInfo?.available ?? false,
        whisperModel: whisperInfo?.modelSize,
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("voiceconfigview.TalkModeStatusUnavailable", {
              defaultValue: "Talk mode status unavailable.",
            }),
      );
    } finally {
      setLoading(false);
    }
  }, [desktopRuntime, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = useCallback(
    async (
      id: string,
      action: () => Promise<void>,
      successMessage?: string,
      refreshAfter = true,
    ) => {
      setBusyAction(id);
      setError(null);
      setMessage(null);
      try {
        await action();
        if (refreshAfter) {
          await refresh();
        }
        if (successMessage) {
          setMessage(successMessage);
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("voiceconfigview.ActionFailed"),
        );
      } finally {
        setBusyAction(null);
      }
    },
    [refresh, t],
  );

  if (!desktopRuntime) {
    return (
      <Card className="border-border/60 bg-card/92 shadow-sm">
        <CardContent className="px-4 py-4 text-xs leading-5 text-muted">
          {t("voiceconfigview.DesktopTalkModeDesktopOnly")}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/60 bg-card/92 shadow-sm">
      <CardHeader className="px-4 py-4 pb-0">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-sm">
              {t("voiceconfigview.DesktopTalkMode")}
            </CardTitle>
            <CardDescription className="mt-1 text-xs-tight leading-5">
              {t("voiceconfigview.TalkModeDescription")}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
            onClick={() =>
              void runAction(
                "voice-talkmode-refresh",
                async () => {},
                t("voiceconfigview.TalkModeStateRefreshed"),
              )
            }
            disabled={loading || busyAction === "voice-talkmode-refresh"}
          >
            {t("common.refresh")}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 px-4 pb-4">
        {(error || message) && (
          <div
            className={`rounded-xl border px-3 py-2.5 text-xs-tight leading-5 ${
              error
                ? "border-danger/40 bg-danger/10 text-danger"
                : "border-ok/40 bg-ok/10 text-ok"
            }`}
          >
            {error ?? message}
          </div>
        )}

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Card className="border-border/50 bg-bg-hover/60 shadow-none">
            <CardContent className="px-2.5 py-2 text-xs-tight">
              <div className="text-2xs text-muted">
                {t("voiceconfigview.State")}
              </div>
              <div className="font-semibold text-txt">{panelState.state}</div>
            </CardContent>
          </Card>
          <Card className="border-border/50 bg-bg-hover/60 shadow-none">
            <CardContent className="px-2.5 py-2 text-xs-tight">
              <div className="text-2xs text-muted">{t("common.enabled")}</div>
              <div className="font-semibold text-txt">
                {panelState.enabled ? t("common.yes") : t("common.no")}
              </div>
            </CardContent>
          </Card>
          <Card className="border-border/50 bg-bg-hover/60 shadow-none">
            <CardContent className="px-2.5 py-2 text-xs-tight">
              <div className="text-2xs text-muted">
                {t("voiceconfigview.Speaking")}
              </div>
              <div className="font-semibold text-txt">
                {panelState.speaking ? t("common.yes") : t("common.no")}
              </div>
            </CardContent>
          </Card>
          <Card className="border-border/50 bg-bg-hover/60 shadow-none">
            <CardContent className="px-2.5 py-2 text-xs-tight">
              <div className="text-2xs text-muted">
                {t("voiceconfigview.Whisper")}
              </div>
              <div className="font-semibold text-txt">
                {panelState.whisperAvailable
                  ? panelState.whisperModel || t("common.available")
                  : t("common.unavailable")}
              </div>
            </CardContent>
          </Card>
        </div>

        <Input
          type="text"
          className="min-h-10 rounded-xl bg-bg text-xs"
          value={phrase}
          onChange={(event) => setPhrase(event.target.value)}
          placeholder={t("voiceconfigview.testPhrase")}
        />

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button
            variant="outline"
            size="sm"
            className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
            onClick={() =>
              void runAction(
                "voice-talkmode-start-stop",
                async () => {
                  if (panelState.enabled) {
                    await invokeDesktopBridgeRequest<void>({
                      rpcMethod: "talkmodeStop",
                      ipcChannel: "talkmode:stop",
                    });
                    return;
                  }

                  const result = await invokeDesktopBridgeRequest<{
                    available: boolean;
                    reason?: string;
                  }>({
                    rpcMethod: "talkmodeStart",
                    ipcChannel: "talkmode:start",
                  });
                  if (result?.available === false) {
                    throw new Error(
                      result.reason || t("voiceconfigview.TalkModeUnavailable"),
                    );
                  }
                },
                panelState.enabled
                  ? t("voiceconfigview.TalkModeStopped")
                  : t("voiceconfigview.TalkModeStarted"),
              )
            }
            disabled={busyAction === "voice-talkmode-start-stop" || loading}
          >
            {panelState.enabled
              ? t("voiceconfigview.StopTalkMode")
              : t("voiceconfigview.StartTalkMode")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
            onClick={() =>
              void runAction(
                "voice-talkmode-speak",
                async () => {
                  await invokeDesktopBridgeRequest<void>({
                    rpcMethod: "talkmodeSpeak",
                    ipcChannel: "talkmode:speak",
                    params: { text: phrase },
                  });
                },
                t("voiceconfigview.SpeechRequested"),
                false,
              )
            }
            disabled={!phrase.trim() || busyAction === "voice-talkmode-speak"}
          >
            {t("voiceconfigview.SpeakTestPhrase")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
            onClick={() =>
              void runAction(
                "voice-talkmode-stop-speaking",
                async () => {
                  await invokeDesktopBridgeRequest<void>({
                    rpcMethod: "talkmodeStopSpeaking",
                    ipcChannel: "talkmode:stopSpeaking",
                  });
                },
                t("voiceconfigview.StoppedCurrentSpeechOutput"),
              )
            }
            disabled={busyAction === "voice-talkmode-stop-speaking"}
          >
            {t("voiceconfigview.StopSpeaking")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

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
    <div className="flex flex-col gap-4 pt-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs font-semibold text-muted">
          {t("voiceconfigview.WakeWord")}
        </div>
        <div className="flex min-h-10 items-center gap-2 rounded-xl border border-border/50 bg-bg-hover px-3">
          <span className="text-xs-tight font-medium text-muted-strong">
            {enabled
              ? t("common.enabled", { defaultValue: "Enabled" })
              : t("common.disabled", { defaultValue: "Disabled" })}
          </span>
          <Switch
            checked={enabled}
            onCheckedChange={() => void handleToggle()}
            aria-label={
              enabled
                ? t("voiceconfigview.DisableWakeWord", {
                    defaultValue: "Disable wake word",
                  })
                : t("voiceconfigview.EnableWakeWord", {
                    defaultValue: "Enable wake word",
                  })
            }
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold">
          {t("voiceconfigview.Triggers")}
        </span>
        <div className="flex min-h-10 flex-wrap gap-1.5 rounded-xl border border-border/60 bg-bg px-2 py-2">
          {triggers.map((trigger) => (
            <span
              key={trigger}
              className="flex min-h-7 items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-1 text-2xs text-txt"
            >
              {trigger}
              {triggers.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-1 h-5 w-5 rounded-full p-0 leading-none text-muted-strong hover:bg-bg-hover hover:text-txt"
                  onClick={() => removeTrigger(trigger)}
                  aria-label={t("voiceconfigview.RemoveTrigger", {
                    defaultValue: 'Remove trigger "{{trigger}}"',
                    trigger,
                  })}
                >
                  ×
                </Button>
              )}
            </span>
          ))}
          <Input
            type="text"
            className="h-7 min-w-[120px] flex-1 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
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
        <div className="text-2xs text-muted">
          {t("voiceconfigview.PressEnterOrComma")}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold">
            {t("voiceconfigview.WakeSensitivity")}
          </span>
          <span className="text-2xs text-muted">{sensitivity.toFixed(2)}s</span>
        </div>
        <input
          type="range"
          min={0.1}
          max={2.0}
          step={0.05}
          value={sensitivity}
          className="w-full accent-accent"
          onChange={(e) =>
            void handleSensitivityChange(parseFloat(e.target.value))
          }
        />
        <div className="text-2xs text-muted">
          {t("voiceconfigview.LowerMoreSensiti")}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold">
          {t("voiceconfigview.ModelSize")}
        </span>
        <div className="grid grid-cols-2 gap-1.5 xl:grid-cols-5">
          {MODEL_SIZES.map((m) => {
            const active = modelSize === m.id;
            return (
              <Button
                key={m.id}
                variant={active ? "default" : "outline"}
                size="sm"
                className="h-auto min-h-12 flex-col rounded-xl py-2"
                onClick={() => void handleModelSizeChange(m.id)}
              >
                <div className="font-semibold">{m.id}</div>
                {m.hintKey && (
                  <div className="text-2xs opacity-70 mt-0.5">
                    {t(m.hintKey)}
                  </div>
                )}
              </Button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold">
          {t("voiceconfigview.Microphone")}
        </span>
        <div className="h-2 w-full overflow-hidden rounded-full bg-border/70">
          <div
            className="h-full rounded-full bg-ok transition-all duration-75"
            style={{ width: `${Math.min(audioLevel * 100, 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

export function VoiceConfigView() {
  const { t, elizaCloudConnected, elizaCloudVoiceProxyAvailable } = useApp();
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>({});
  const [swabbleServerConfig, setSwabbleServerConfig] =
    useState<Partial<SwabbleConfig> | null>(null);
  const [loading, setLoading] = useState(true);
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
  const cloudVoiceAvailable = elizaCloudVoiceProxyAvailable;
  const hasElevenLabsApiKey = hasConfiguredApiKey(
    voiceConfig.elevenlabs?.apiKey,
  );
  const defaultVoiceMode: VoiceMode = cloudVoiceAvailable
    ? hasElevenLabsApiKey
      ? "own-key"
      : "cloud"
    : "own-key";
  const currentMode: VoiceMode = voiceConfig.mode ?? defaultVoiceMode;
  const providerInfo = VOICE_PROVIDERS.find((p) => p.id === currentProvider);
  // Cloud vs own-key only applies to providers that need credentials. Edge TTS
  // has no API key — do not gate "Configured" on Eliza Cloud when Edge is selected.
  const isConfigured = (() => {
    if (!providerInfo?.needsKey) return true;
    if (currentMode === "cloud") return cloudVoiceAvailable;
    return hasConfiguredApiKey(voiceConfig.elevenlabs?.apiKey);
  })();

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

  const performSave = useCallback(async () => {
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
      mode: provider === "elevenlabs" ? currentMode : undefined,
      elevenlabs: normalizedElevenLabs,
    };
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
    setDirty(false);
  }, [currentMode, swabbleServerConfig, voiceConfig]);

  const { saving, saveError, saveSuccess, handleSave } = useSettingsSave({
    onSave: performSave,
    errorFallback: t("skillsview.failedToSave", {
      defaultValue: "Failed to save",
    }),
  });

  if (loading) {
    return (
      <div className="rounded-2xl border border-border/60 bg-card/92 px-4 py-6 text-center text-xs text-muted shadow-sm">
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
      <div className="rounded-2xl border border-border/60 bg-card/92 p-4 shadow-sm">
        <div className="text-xs font-semibold text-muted">
          {t("voiceconfigview.TTSProvider")}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {VOICE_PROVIDERS.map((p) => {
            const active = currentProvider === p.id;
            return (
              <Button
                key={p.id}
                variant={active ? "default" : "outline"}
                size="sm"
                className="h-auto min-h-14 flex-col rounded-xl py-2"
                onClick={() => handleProviderChange(p.id)}
              >
                <div className="font-semibold">
                  {t(p.labelKey, { defaultValue: p.label })}
                </div>
                <div className="text-2xs opacity-70 mt-0.5">
                  {t(p.hintKey, { defaultValue: p.hint })}
                </div>
              </Button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col gap-2 rounded-2xl border border-border/60 bg-card/92 px-4 py-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs leading-5 text-txt">
          {currentProvider === "elevenlabs"
            ? `ElevenLabs — ${currentMode === "cloud" ? t("voiceconfigview.ServedViaElizaCloud") : t("voiceconfigview.RequiresApiKey")}`
            : `${providerInfo ? t(providerInfo.labelKey, { defaultValue: providerInfo.label }) : ""} — ${t("voiceconfigview.NoApiKeyNeeded")}`}
        </span>
        <span
          className={`inline-flex items-center rounded-full border px-2 py-1 text-2xs font-medium ${
            isConfigured
              ? "border-ok/35 bg-ok/10 text-ok"
              : "border-warn/35 bg-warn/10 text-warn"
          }`}
        >
          {isConfigured
            ? t("config-field.Configured")
            : t("mediasettingssection.NeedsSetup")}
        </span>
      </div>
      {currentProvider === "elevenlabs" && (
        <div className="rounded-2xl border border-border/60 bg-card/92 p-4 shadow-sm flex flex-col gap-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-xs font-semibold text-muted">
              {t("voiceconfigview.APISource")}
            </span>
            <CloudSourceModeToggle
              mode={currentMode}
              onChange={handleModeChange}
            />
          </div>
          {currentMode === "cloud" && (
            <CloudConnectionStatus
              connected={elizaCloudConnected}
              disconnectedText={t("elizaclouddashboard.ElizaCloudNotConnected")}
            />
          )}
          {currentMode === "own-key" && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold">
                {t("onboarding.elevenLabsApiKey")}
              </span>
              <Input
                type="password"
                className="min-h-10 rounded-xl bg-bg text-xs"
                placeholder={
                  voiceConfig.elevenlabs?.apiKey
                    ? t("mediasettingssection.ApiKeySetLeaveBlank")
                    : t("mediasettingssection.EnterApiKey")
                }
                onChange={(e) => handleApiKeyChange(e.target.value)}
              />
              <div className="text-2xs text-muted">
                {t("voiceconfigview.GetYourKeyAt")}{" "}
                <a
                  href="https://elevenlabs.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-txt underline decoration-accent underline-offset-2 hover:opacity-80"
                >
                  {t("voiceconfigview.elevenlabsIo")}
                </a>
              </div>
              <div className="text-2xs text-muted">
                {t("voiceconfigview.FastPathDefaultE")}
                {DEFAULT_ELEVEN_FAST_MODEL}`).
              </div>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <div className="text-xs font-semibold">{t("common.voice")}</div>
            <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
              {PREMADE_VOICES.map((preset) => {
                const active = selectedVoiceId === preset.voiceId;
                return (
                  <Button
                    key={preset.id}
                    variant={active ? "default" : "outline"}
                    className={`h-auto min-h-16 flex-col items-start rounded-xl px-3 py-2.5 text-left transition-all ${
                      active
                        ? "border-accent/45 bg-accent/12 text-txt shadow-sm"
                        : "border-border/60 bg-bg text-txt hover:border-border-strong hover:bg-bg-hover"
                    }`}
                    onClick={() => handleVoiceSelect(preset.voiceId)}
                  >
                    <div className="font-semibold text-xs truncate w-full">
                      {preset.nameKey
                        ? t(preset.nameKey, { defaultValue: preset.name })
                        : preset.name}
                    </div>
                    <div className="text-2xs text-muted truncate w-full">
                      {preset.hintKey
                        ? t(preset.hintKey, { defaultValue: preset.hint })
                        : preset.hint}
                    </div>
                  </Button>
                );
              })}
            </div>
          </div>
          {selectedPreset && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button
                variant="outline"
                size="sm"
                className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
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
                  className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
                  onClick={() => {
                    if (audioRef.current) {
                      audioRef.current.pause();
                      setTesting(false);
                    }
                  }}
                >
                  {t("common.stop")}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {currentProvider === "edge" && (
        <div className="rounded-2xl border border-border/60 bg-card/92 px-4 py-3 text-xs leading-5 text-muted shadow-sm">
          {t("voiceconfigview.EdgeTTSUsesMicros")}
        </div>
      )}
      {currentProvider === "robot-voice" && (
        <div className="rounded-2xl border border-border/60 bg-card/92 px-4 py-3 text-xs leading-5 text-muted shadow-sm">
          {t("voiceconfigview.SimpleVoiceUsesYo")}
        </div>
      )}
      <WakeWordSection serverConfig={swabbleServerConfig} />

      <DesktopTalkModePanel />

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
