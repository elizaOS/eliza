import { ASR_PROVIDERS } from "@elizaos/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import {
  type AsrProvider,
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
import { useDefaultProviderPresets } from "../../hooks/useDefaultProviderPresets";
import { useApp } from "../../state";
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
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import { SaveFooter } from "../ui/save-footer";
import { SettingsInput } from "../ui/settings-controls";
import { Switch } from "../ui/switch";
import { AdvancedToggle } from "./AdvancedToggle";
import { useAdvancedSettingsEnabled } from "./AdvancedToggle.hooks";
import { useSettingsSave } from "./settings-control-primitives.hooks";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

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
  }>({
    state: "idle",
    enabled: false,
    speaking: false,
  });

  const refresh = useCallback(async () => {
    if (!desktopRuntime) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const [state, enabled, speaking] = await Promise.all([
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
      ]);
      setPanelState({
        state: state?.state ?? "idle",
        enabled: enabled?.enabled ?? false,
        speaking: speaking?.speaking ?? false,
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

  const { ref: refreshRef, agentProps: refreshAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "voice-talkmode-refresh",
      role: "button",
      label: t("common.refresh"),
      group: "voice-talkmode",
      onActivate: () =>
        void runAction(
          "voice-talkmode-refresh",
          async () => {},
          t("voiceconfigview.TalkModeStateRefreshed"),
        ),
    });
  const { ref: phraseRef, agentProps: phraseAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "voice-talkmode-phrase",
      role: "text-input",
      label: t("voiceconfigview.testPhrase"),
      group: "voice-talkmode",
      getValue: () => phrase,
      onFill: setPhrase,
    });
  const { ref: startStopRef, agentProps: startStopAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "voice-talkmode-start-stop",
      role: "button",
      label: panelState.enabled
        ? t("voiceconfigview.StopTalkMode")
        : t("voiceconfigview.StartTalkMode"),
      group: "voice-talkmode",
      status: panelState.enabled ? "active" : "inactive",
      onActivate: () =>
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
        ),
    });
  const { ref: speakRef, agentProps: speakAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "voice-talkmode-speak",
      role: "button",
      label: t("voiceconfigview.SpeakTestPhrase"),
      group: "voice-talkmode",
      status: phrase.trim() ? "active" : "inactive",
      onActivate: () =>
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
        ),
    });
  const { ref: stopSpeakingRef, agentProps: stopSpeakingAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "voice-talkmode-stop-speaking",
      role: "button",
      label: t("voiceconfigview.StopSpeaking"),
      group: "voice-talkmode",
      onActivate: () =>
        void runAction(
          "voice-talkmode-stop-speaking",
          async () => {
            await invokeDesktopBridgeRequest<void>({
              rpcMethod: "talkmodeStopSpeaking",
              ipcChannel: "talkmode:stopSpeaking",
            });
          },
          t("voiceconfigview.StoppedCurrentSpeechOutput"),
        ),
    });

  if (!desktopRuntime) {
    return (
      <Card className="border-border/60 bg-card/92 ">
        <CardContent className="px-4 py-4 text-xs leading-5 text-muted">
          {t("voiceconfigview.DesktopTalkModeDesktopOnly")}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/60 bg-card/92 ">
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
            ref={refreshRef}
            variant="outline"
            size="sm"
            className="min-h-10 rounded-sm px-3 text-xs-tight font-semibold"
            onClick={() =>
              void runAction(
                "voice-talkmode-refresh",
                async () => {},
                t("voiceconfigview.TalkModeStateRefreshed"),
              )
            }
            disabled={loading || busyAction === "voice-talkmode-refresh"}
            {...refreshAgentProps}
          >
            {t("common.refresh")}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 px-4 pb-4">
        {(error || message) && (
          <div
            className={`rounded-sm border px-3 py-2.5 text-xs-tight leading-5 ${
              error
                ? "border-danger/40 bg-danger/10 text-danger"
                : "border-ok/40 bg-ok/10 text-ok"
            }`}
          >
            {error ?? message}
          </div>
        )}

        <div className="grid gap-2 sm:grid-cols-3">
          <Card className="border-border/50 bg-bg-hover/60 shadow-none">
            <CardContent className="px-2.5 py-2 text-xs-tight">
              <div className="text-xs text-muted">
                {t("voiceconfigview.State")}
              </div>
              <div className="font-semibold text-txt">{panelState.state}</div>
            </CardContent>
          </Card>
          <Card className="border-border/50 bg-bg-hover/60 shadow-none">
            <CardContent className="px-2.5 py-2 text-xs-tight">
              <div className="text-xs text-muted">{t("common.enabled")}</div>
              <div className="font-semibold text-txt">
                {panelState.enabled ? t("common.yes") : t("common.no")}
              </div>
            </CardContent>
          </Card>
          <Card className="border-border/50 bg-bg-hover/60 shadow-none">
            <CardContent className="px-2.5 py-2 text-xs-tight">
              <div className="text-xs text-muted">
                {t("voiceconfigview.Speaking")}
              </div>
              <div className="font-semibold text-txt">
                {panelState.speaking ? t("common.yes") : t("common.no")}
              </div>
            </CardContent>
          </Card>
        </div>

        <Input
          ref={phraseRef}
          type="text"
          className="min-h-10 rounded-sm bg-bg text-xs"
          value={phrase}
          onChange={(event) => setPhrase(event.target.value)}
          placeholder={t("voiceconfigview.testPhrase")}
          {...phraseAgentProps}
        />

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button
            ref={startStopRef}
            variant="outline"
            size="sm"
            className="min-h-10 rounded-sm px-3 text-xs-tight font-semibold"
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
            {...startStopAgentProps}
          >
            {panelState.enabled
              ? t("voiceconfigview.StopTalkMode")
              : t("voiceconfigview.StartTalkMode")}
          </Button>
          <Button
            ref={speakRef}
            variant="outline"
            size="sm"
            className="min-h-10 rounded-sm px-3 text-xs-tight font-semibold"
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
            {...speakAgentProps}
          >
            {t("voiceconfigview.SpeakTestPhrase")}
          </Button>
          <Button
            ref={stopSpeakingRef}
            variant="outline"
            size="sm"
            className="min-h-10 rounded-sm px-3 text-xs-tight font-semibold"
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
            {...stopSpeakingAgentProps}
          >
            {t("voiceconfigview.StopSpeaking")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RemoveTriggerButton({
  trigger,
  onRemove,
  label,
}: {
  trigger: string;
  onRemove: () => void;
  label: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `voice-wakeword-remove-${trigger}`,
    role: "button",
    label,
    group: "voice-wakeword",
    onActivate: onRemove,
  });
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      className="ml-1 h-5 w-5 rounded-full p-0 leading-none text-muted-strong hover:bg-bg-hover hover:text-txt"
      onClick={onRemove}
      aria-label={label}
      {...agentProps}
    >
      ×
    </Button>
  );
}

function ModelSizeButton({
  id,
  active,
  hint,
  onSelect,
}: {
  id: NonNullable<SwabbleConfig["modelSize"]>;
  active: boolean;
  hint?: string;
  onSelect: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `voice-wakeword-model-${id}`,
    role: "button",
    label: id,
    group: "voice-wakeword",
    status: active ? "active" : undefined,
    onActivate: onSelect,
  });
  return (
    <Button
      ref={ref}
      variant={active ? "default" : "outline"}
      size="sm"
      className="h-auto min-h-12 flex-col rounded-sm py-2"
      onClick={onSelect}
      {...agentProps}
    >
      <div className="font-semibold">{id}</div>
      {hint && <div className="mt-0.5 text-xs opacity-90">{hint}</div>}
    </Button>
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
  const [postTriggerGap, setPostTriggerGap] = useState(0.45);
  const [modelSize, setModelSize] =
    useState<NonNullable<SwabbleConfig["modelSize"]>>("base");
  const [audioLevel, setAudioLevel] = useState(0);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const swabble = getSwabblePlugin();
        const [{ config }, { listening }] = await Promise.all([
          swabble.getConfig(),
          swabble.isListening(),
        ]);
        const resolved = config ?? serverConfig ?? null;
        if (resolved) {
          if (resolved.triggers?.length) setTriggers(resolved.triggers);
          if (resolved.minPostTriggerGap != null)
            setPostTriggerGap(resolved.minPostTriggerGap);
          if (resolved.modelSize) setModelSize(resolved.modelSize);
        }
        setEnabled(listening);
      } catch {
        // Plugin not available on this platform — silently ignore
      }
    })();
  }, [serverConfig]);

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
      minPostTriggerGap: postTriggerGap,
      modelSize,
    }),
    [triggers, postTriggerGap, modelSize],
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

  const handlePostTriggerGapChange = useCallback(async (val: number) => {
    setPostTriggerGap(val);
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

  const { ref: enableRef, agentProps: enableAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "voice-wakeword-enable",
      role: "toggle",
      label: t("voiceconfigview.EnableWakeWord", {
        defaultValue: "Enable wake word",
      }),
      group: "voice-wakeword",
      status: enabled ? "on" : "off",
      getValue: () => enabled,
      onActivate: () => void handleToggle(),
    });
  const { ref: addTriggerRef, agentProps: addTriggerAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "voice-wakeword-add-trigger",
      role: "text-input",
      label: t("voiceconfigview.AddTrigger", { defaultValue: "Add trigger" }),
      group: "voice-wakeword",
      getValue: () => triggerInput,
      onFill: (value) => {
        addTrigger(value);
        setTriggerInput("");
      },
    });
  const { ref: gapRef, agentProps: gapAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "voice-wakeword-post-trigger-gap",
      role: "slider",
      label: t("voiceconfigview.PostTriggerGap", {
        defaultValue: "Post-trigger gap",
      }),
      group: "voice-wakeword",
      getValue: () => postTriggerGap,
      onFill: (value) => {
        const n = Number(value);
        if (Number.isFinite(n)) {
          void handlePostTriggerGapChange(Math.min(2, Math.max(0.1, n)));
        }
      },
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm font-medium text-txt-strong">
          {t("voiceconfigview.EnableWakeWord", {
            defaultValue: "Enable wake word",
          })}
        </div>
        <div className="flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-3">
          <span className="text-xs-tight font-medium text-muted-strong">
            {enabled
              ? t("common.enabled", { defaultValue: "Enabled" })
              : t("common.disabled", { defaultValue: "Disabled" })}
          </span>
          <Switch
            ref={enableRef}
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
            {...enableAgentProps}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold">
          {t("voiceconfigview.Triggers")}
        </span>
        <div className="flex min-h-10 flex-wrap gap-1.5 rounded-sm border border-border/60 bg-bg px-2 py-2">
          {triggers.map((trigger) => (
            <span
              key={trigger}
              className="flex min-h-7 items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-1 text-xs text-txt"
            >
              {trigger}
              {triggers.length > 1 && (
                <RemoveTriggerButton
                  trigger={trigger}
                  onRemove={() => removeTrigger(trigger)}
                  label={t("voiceconfigview.RemoveTrigger", {
                    defaultValue: 'Remove trigger "{{trigger}}"',
                    trigger,
                  })}
                />
              )}
            </span>
          ))}
          <Input
            ref={addTriggerRef}
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
            {...addTriggerAgentProps}
          />
        </div>
        <div className="text-xs text-muted">
          {t("voiceconfigview.PressEnterOrComma")}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold">
            {t("voiceconfigview.PostTriggerGap", {
              defaultValue: "Post-trigger gap",
            })}
          </span>
          <span className="text-xs text-muted">
            {postTriggerGap.toFixed(2)}s
          </span>
        </div>
        <input
          ref={gapRef}
          type="range"
          min={0.1}
          max={2.0}
          step={0.05}
          value={postTriggerGap}
          className="w-full accent-accent"
          aria-label={t("voiceconfigview.PostTriggerGap", {
            defaultValue: "Post-trigger gap",
          })}
          onChange={(e) =>
            void handlePostTriggerGapChange(parseFloat(e.target.value))
          }
          {...gapAgentProps}
        />
        <div className="text-xs text-muted">
          {t("voiceconfigview.PostTriggerGapHint", {
            defaultValue:
              "Quiet time after the wake word before listening resumes.",
          })}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold">
          {t("voiceconfigview.ModelSize")}
        </span>
        <div className="grid grid-cols-2 gap-1.5 xl:grid-cols-5">
          {MODEL_SIZES.map((m) => (
            <ModelSizeButton
              key={m.id}
              id={m.id}
              active={modelSize === m.id}
              hint={m.hintKey ? t(m.hintKey) : undefined}
              onSelect={() => void handleModelSizeChange(m.id)}
            />
          ))}
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

function AsrProviderButton({
  id,
  label,
  hint,
  active,
  onSelect,
}: {
  id: AsrProvider;
  label: string;
  hint: string;
  active: boolean;
  onSelect: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `voice-asr-provider-${id}`,
    role: "button",
    label,
    group: "voice-asr",
    status: active ? "active" : undefined,
    onActivate: onSelect,
  });
  return (
    <Button
      ref={ref}
      variant={active ? "default" : "outline"}
      size="sm"
      className="h-auto min-h-14 flex-col rounded-sm py-2"
      onClick={onSelect}
      {...agentProps}
    >
      <div className="font-semibold">{label}</div>
      <div className="mt-0.5 text-xs opacity-90">{hint}</div>
    </Button>
  );
}

/**
 * Advanced speech-to-text provider picker. Overrides the device default;
 * hidden until the AdvancedToggle is on.
 */
function AsrAdvancedSection({
  currentAsrProvider,
  onChange,
  defaultAsrProvider,
}: {
  currentAsrProvider: AsrProvider;
  onChange: (provider: AsrProvider) => void;
  defaultAsrProvider: AsrProvider;
}) {
  const { t } = useApp();
  const [localStatusBusy, setLocalStatusBusy] = useState(false);

  // A non-empty local-inference downloads list means the model bundle isn't
  // ready yet, so we show "downloading" rather than implying it's online.
  useEffect(() => {
    if (currentAsrProvider !== "local-inference") {
      setLocalStatusBusy(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await client.getLocalInferenceHub();
        if (cancelled) return;
        const hasActiveDownloads = Array.isArray(snapshot?.downloads)
          ? snapshot.downloads.length > 0
          : false;
        setLocalStatusBusy(hasActiveDownloads);
      } catch {
        if (!cancelled) setLocalStatusBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentAsrProvider]);

  return (
    <div className="rounded-sm border border-border/60 bg-card/92 p-4 flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-semibold text-muted">
          {t("voiceconfigview.AsrProvider", {
            defaultValue: "Speech-to-text",
          })}
        </span>
        <span className="text-xs text-muted">
          {t("voiceconfigview.AsrDeviceDefault", {
            defaultValue: "Device default: {{provider}}",
            provider: defaultAsrProvider,
          })}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {ASR_PROVIDERS.map((p) => (
          <AsrProviderButton
            key={p.id}
            id={p.id}
            label={p.label}
            hint={p.hint}
            active={currentAsrProvider === p.id}
            onSelect={() => onChange(p.id)}
          />
        ))}
      </div>
      {currentAsrProvider === "local-inference" && localStatusBusy && (
        <div className="rounded-sm border border-warn/35 bg-warn/10 px-3 py-2 text-xs leading-5 text-warn">
          {t("voiceconfigview.AsrDownloading", {
            defaultValue: "Downloading local model — using cloud until ready.",
          })}
        </div>
      )}
      {currentAsrProvider === "openai" && (
        <div className="rounded-sm border border-border/40 bg-bg-hover/60 px-3 py-2 text-xs leading-5 text-muted">
          {t("voiceconfigview.AsrUsesOpenAiKey", {
            defaultValue:
              "Uses your OpenAI API key from the Providers section.",
          })}
        </div>
      )}
    </div>
  );
}

function TtsProviderButton({
  id,
  label,
  hint,
  active,
  onSelect,
}: {
  id: VoiceProvider;
  label: string;
  hint: string;
  active: boolean;
  onSelect: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `voice-tts-provider-${id}`,
    role: "button",
    label,
    group: "voice-tts",
    status: active ? "active" : undefined,
    onActivate: onSelect,
  });
  return (
    <Button
      ref={ref}
      variant={active ? "default" : "outline"}
      className="h-auto min-h-14 flex-col rounded-md py-2"
      onClick={onSelect}
      {...agentProps}
    >
      <div className="font-semibold">{label}</div>
      <div className="mt-0.5 text-xs opacity-90">{hint}</div>
    </Button>
  );
}

function PremadeVoiceButton({
  voiceId,
  name,
  hint,
  active,
  onSelect,
}: {
  voiceId: string;
  name: string;
  hint: string;
  active: boolean;
  onSelect: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `voice-tts-voice-${voiceId}`,
    role: "button",
    label: name,
    group: "voice-tts",
    status: active ? "active" : undefined,
    onActivate: onSelect,
  });
  return (
    <Button
      ref={ref}
      variant={active ? "default" : "outline"}
      className={`h-auto min-h-16 flex-col items-start rounded-md px-3 py-2.5 text-left transition-all ${
        active
          ? "border-accent/45 bg-accent/12 text-txt "
          : "border-border/60 bg-bg text-txt hover:border-border-strong hover:bg-surface"
      }`}
      onClick={onSelect}
      {...agentProps}
    >
      <div className="font-semibold text-xs truncate w-full">{name}</div>
      <div className="text-xs text-muted truncate w-full">{hint}</div>
    </Button>
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

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const { defaults: providerDefaults } = useDefaultProviderPresets();
  const advancedEnabled = useAdvancedSettingsEnabled();

  // Falls back to the device default until the user picks a provider.
  const currentProvider = voiceConfig.provider ?? providerDefaults.tts;
  const currentAsrProvider: AsrProvider =
    voiceConfig.asr?.provider ?? providerDefaults.asr;
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

  const handleAsrProviderChange = useCallback((provider: AsrProvider) => {
    setVoiceConfig((prev) => ({
      ...prev,
      asr: { ...(prev.asr ?? {}), provider },
    }));
    setDirty(true);
  }, []);

  const { ref: apiKeyRef, agentProps: apiKeyAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "voice-tts-elevenlabs-key",
      role: "text-input",
      label: t("settings.voice.elevenLabsApiKey", {
        defaultValue: "ElevenLabs API key",
      }),
      group: "voice-tts",
      getValue: () => voiceConfig.elevenlabs?.apiKey ?? "",
      onFill: handleApiKeyChange,
    });

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
    // Persist `asr` only when the user has set it; the default is recomputed
    // on every load.
    const normalizedAsr: VoiceConfig["asr"] | undefined = voiceConfig.asr
      ? {
          provider: voiceConfig.asr.provider,
          ...(voiceConfig.asr.modelId
            ? { modelId: voiceConfig.asr.modelId }
            : {}),
        }
      : undefined;
    const normalizedVoiceConfig: VoiceConfig = {
      ...voiceConfig,
      provider,
      mode: provider === "elevenlabs" ? currentMode : undefined,
      elevenlabs: normalizedElevenLabs,
      asr: normalizedAsr,
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
      <div className="rounded-sm border border-border/60 bg-card/92 px-4 py-6 text-center text-xs text-muted ">
        {t("voiceconfigview.LoadingVoiceConfig")}
      </div>
    );
  }

  const selectedVoiceId = voiceConfig.elevenlabs?.voiceId;
  const selectedPreset = PREMADE_VOICES.find(
    (p) => p.voiceId === selectedVoiceId,
  );

  return (
    <SettingsStack>
      <SettingsGroup
        bare
        title={t("voiceconfigview.TTSProvider")}
        footer={
          <span className="flex items-center gap-2">
            <span className="text-txt">
              {currentProvider === "elevenlabs"
                ? `ElevenLabs — ${currentMode === "cloud" ? t("voiceconfigview.ServedViaElizaCloud") : t("voiceconfigview.RequiresApiKey")}`
                : `${providerInfo ? t(providerInfo.labelKey, { defaultValue: providerInfo.label }) : ""} — ${t("voiceconfigview.NoApiKeyNeeded")}`}
            </span>
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                isConfigured
                  ? "border-ok/35 bg-ok/10 text-ok"
                  : "border-warn/35 bg-warn/10 text-warn"
              }`}
            >
              {isConfigured
                ? t("config-field.Configured")
                : t("mediasettingssection.NeedsSetup")}
            </span>
          </span>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {VOICE_PROVIDERS.map((p) => (
            <TtsProviderButton
              key={p.id}
              id={p.id}
              label={t(p.labelKey, { defaultValue: p.label })}
              hint={t(p.hintKey, { defaultValue: p.hint })}
              active={currentProvider === p.id}
              onSelect={() => handleProviderChange(p.id)}
            />
          ))}
        </div>
      </SettingsGroup>

      {currentProvider === "elevenlabs" && (
        <SettingsGroup
          title={t("voiceconfigview.APISource")}
          action={
            <CloudSourceModeToggle
              mode={currentMode}
              onChange={handleModeChange}
            />
          }
        >
          {currentMode === "cloud" ? (
            <SettingsRow label={t("voiceconfigview.APISource")} stacked>
              <CloudConnectionStatus
                connected={elizaCloudConnected}
                disconnectedText={t(
                  "elizaclouddashboard.ElizaCloudNotConnected",
                )}
              />
            </SettingsRow>
          ) : null}
          {currentMode === "own-key" ? (
            <SettingsRow
              label={t("settings.voice.elevenLabsApiKey")}
              description={
                <>
                  {t("voiceconfigview.GetYourKeyAt")}{" "}
                  <a
                    href="https://elevenlabs.io"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-txt underline decoration-accent underline-offset-2 hover:opacity-80"
                  >
                    {t("voiceconfigview.elevenlabsIo")}
                  </a>
                  {" · "}
                  {t("voiceconfigview.FastPathDefaultE")}
                  <code>{DEFAULT_ELEVEN_FAST_MODEL}</code>
                </>
              }
              stacked
            >
              <SettingsInput
                ref={apiKeyRef}
                variant="touch"
                className="w-full"
                type="password"
                placeholder={
                  voiceConfig.elevenlabs?.apiKey
                    ? t("mediasettingssection.ApiKeySetLeaveBlank")
                    : t("mediasettingssection.EnterApiKey")
                }
                onChange={(e) => handleApiKeyChange(e.target.value)}
                {...apiKeyAgentProps}
              />
            </SettingsRow>
          ) : null}
          <SettingsRow label={t("common.voice")} stacked>
            <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
              {PREMADE_VOICES.map((preset) => (
                <PremadeVoiceButton
                  key={preset.id}
                  voiceId={preset.voiceId}
                  name={
                    preset.nameKey
                      ? t(preset.nameKey, { defaultValue: preset.name })
                      : preset.name
                  }
                  hint={
                    preset.hintKey
                      ? t(preset.hintKey, { defaultValue: preset.hint })
                      : preset.hint
                  }
                  active={selectedVoiceId === preset.voiceId}
                  onSelect={() => handleVoiceSelect(preset.voiceId)}
                />
              ))}
            </div>
          </SettingsRow>
          {selectedPreset ? (
            <SettingsRow label={t("voiceconfigview.Microphone")} stacked>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Button
                  variant="outline"
                  className="h-11 rounded-md px-3 text-sm font-semibold"
                  disabled={testing}
                  onClick={() => handleTestVoice(selectedPreset.previewUrl)}
                >
                  {testing
                    ? t("voiceconfigview.Playing")
                    : t("voiceconfigview.TestVoice", {
                        name: selectedPreset.name,
                      })}
                </Button>
                {testing ? (
                  <Button
                    variant="outline"
                    className="h-11 rounded-md px-3 text-sm font-semibold"
                    onClick={() => {
                      if (audioRef.current) {
                        audioRef.current.pause();
                        setTesting(false);
                      }
                    }}
                  >
                    {t("common.stop")}
                  </Button>
                ) : null}
              </div>
            </SettingsRow>
          ) : null}
        </SettingsGroup>
      )}
      {currentProvider === "edge" && (
        <SettingsGroup bare>
          <div className="rounded-lg border border-border bg-card px-4 py-3 text-xs leading-5 text-muted">
            {t("voiceconfigview.EdgeTTSUsesMicros")}
          </div>
        </SettingsGroup>
      )}
      {currentProvider === "robot-voice" && (
        <SettingsGroup bare>
          <div className="rounded-lg border border-border bg-card px-4 py-3 text-xs leading-5 text-muted">
            {t("voiceconfigview.SimpleVoiceUsesYo")}
          </div>
        </SettingsGroup>
      )}

      <SettingsGroup>
        <SettingsRow
          label={t("voiceconfigview.advancedSettings", {
            defaultValue: "Advanced settings",
          })}
          description={t("voiceconfigview.advancedSettingsHint", {
            defaultValue:
              "Show ASR (speech-to-text) provider picker and per-provider overrides.",
          })}
          control={<AdvancedToggle label="Advanced" />}
        />
      </SettingsGroup>

      {advancedEnabled && (
        <SettingsGroup bare>
          <AsrAdvancedSection
            currentAsrProvider={currentAsrProvider}
            onChange={handleAsrProviderChange}
            defaultAsrProvider={providerDefaults.asr}
          />
        </SettingsGroup>
      )}

      <SettingsGroup bare title={t("voiceconfigview.WakeWord")}>
        <WakeWordSection serverConfig={swabbleServerConfig} />
      </SettingsGroup>

      <SettingsGroup bare>
        <DesktopTalkModePanel />
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
