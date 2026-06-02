import { Capacitor } from "@capacitor/core";
import * as React from "react";
import { client } from "../api";
import { invokeDesktopBridgeRequest } from "../bridge";
import { getBootConfig } from "../config/boot-config";
import {
  canSelectLocalRuntime,
  isAndroid,
  isDesktopPlatform,
  isIOS,
} from "../platform/init";
import {
  addAgentProfile,
  createPersistedActiveServer,
  savePersistedActiveServer,
  useApp,
} from "../state";
import { isCloudStatusAuthenticated, preOpenWindow } from "../utils";
import {
  createVoiceCapture,
  type VoiceCaptureHandle,
  type VoiceCaptureState,
} from "../voice";
import { isLocalAsrCaptureSupported } from "../voice/local-asr-capture";
import { autoDownloadRecommendedLocalModelInBackground } from "./auto-download-recommended";
import {
  applyFirstRunVoiceTranscript,
  buildFirstRunSubmitPlan,
  clearPersistedFirstRunState,
  type FirstRunDraftUpdate,
  type FirstRunProfileDraft,
  type FirstRunRuntime,
  type FirstRunStep,
  firstRunDownloadsLocalModel,
  firstRunNeedsCloudConnect,
  firstRunRuntimeTarget,
  isFirstRunPromptEcho,
  loadPersistedFirstRunState,
  normalizeCloudOnlyFirstRunState,
  normalizeFirstRunName,
  previousFirstRunStep,
  savePersistedFirstRunState,
  validateFirstRunSubmitDraft,
} from "./first-run";
import {
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
  MOBILE_LOCAL_AGENT_LABEL,
  MOBILE_LOCAL_AGENT_SERVER_ID,
  persistMobileRuntimeModeForServerTarget,
} from "./mobile-runtime-mode";
import { readFirstRunRuntimeTarget } from "./reload-into-first-run-runtime";
import {
  type MicrophonePermissionController,
  useMicrophonePermission,
} from "./use-microphone-permission";
import {
  FIRST_RUN_VOICE_PREPARING_MESSAGE,
  prepareFirstRunVoiceAndTranscription,
  resolveFirstRunLocalAgentApiBase,
} from "./voice-readiness";

type NativeAgentPlugin = {
  start?: (options?: { apiBase?: string; mode?: string }) => Promise<unknown>;
};

const FIRST_RUN_AGENT_WAIT_MS = 180_000;
const FIRST_RUN_LISTEN_AFTER_SPEECH_DELAY_MS = 450;
const FIRST_RUN_LOCAL_ASR_AUTO_STOP = {
  startGraceMs: 300,
  minSpeechMs: 220,
  silenceMs: 850,
  maxSpeechMs: 10_000,
};

export interface FirstRunVoiceState {
  supported: boolean;
  listening: boolean;
  speaking: boolean;
  transcript: string;
  error: string | null;
}

export interface FirstRunController {
  step: FirstRunStep;
  draft: FirstRunProfileDraft;
  localRuntimeAvailable: boolean;
  cloudOnly: boolean;
  elizaCloudConnected: boolean;
  submitting: boolean;
  busyText: string | null;
  error: string | null;
  cloudError: string | null | undefined;
  voice: FirstRunVoiceState;
  microphone: MicrophonePermissionController;
  primaryLabel: string;
  canBack: boolean;
  updateDraft: FirstRunDraftUpdate;
  setStep: (step: FirstRunStep) => void;
  goBack: () => void;
  finishRuntime: () => Promise<void>;
  startVoice: () => Promise<void>;
  stopVoice: () => Promise<void>;
  toggleVoice: () => Promise<void>;
  onPromptReady: (promptText: string, lineId: string) => void;
}

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
};

type FirstRunAsrProvider = "local-inference" | "browser";

function isFirstRunBrowserSpeechRecognitionSupported(): boolean {
  if (typeof window === "undefined") return false;
  const speechWindow = window as SpeechRecognitionWindow;
  return (
    typeof speechWindow.SpeechRecognition === "function" ||
    typeof speechWindow.webkitSpeechRecognition === "function"
  );
}

function resolveFirstRunAsrProvider(): FirstRunAsrProvider | null {
  if (isLocalAsrCaptureSupported()) return "local-inference";
  if (isDesktopPlatform()) return null;
  if (isFirstRunBrowserSpeechRecognitionSupported()) return "browser";
  return null;
}

function isFirstRunVoiceInputSupported(): boolean {
  return resolveFirstRunAsrProvider() !== null;
}

function isFirstRunVoiceOutputSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function resolveFirstRunVoiceLocale(language: string): string {
  if (language === "ja") return "ja-JP";
  if (language === "ko") return "ko-KR";
  if (language === "pt") return "pt-BR";
  if (language === "vi") return "vi-VN";
  if (language === "zh-CN") return "zh-CN";
  if (language === "es") return "es-ES";
  return "en-US";
}

function formatFirstRunVoiceError(err: unknown): string {
  return err instanceof Error ? err.message : "Voice input failed.";
}

function readSyncOnDeviceAgentBearer(): string | null {
  try {
    const bridge = (
      globalThis as typeof globalThis & {
        ElizaNative?: { getLocalAgentToken?: () => string | null };
      }
    ).ElizaNative;
    const token = bridge?.getLocalAgentToken?.();
    if (typeof token !== "string") return null;
    const trimmed = token.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function startMobileLocalAgent(): Promise<void> {
  if (!isAndroid && !isIOS) return;
  try {
    const capacitorWithPlugins = Capacitor as typeof Capacitor & {
      Plugins?: Record<string, NativeAgentPlugin | undefined>;
    };
    const registeredAgent =
      capacitorWithPlugins.Plugins?.Agent ??
      Capacitor.registerPlugin<NativeAgentPlugin>("Agent");
    await registeredAgent.start?.({
      apiBase: resolveFirstRunLocalAgentApiBase(),
      mode: "local",
    });
  } catch {
    const agentPluginId = "@elizaos/capacitor-agent";
    const { Agent } = await import(/* @vite-ignore */ agentPluginId);
    await (Agent as NativeAgentPlugin | undefined)?.start?.({
      apiBase: resolveFirstRunLocalAgentApiBase(),
      mode: "local",
    });
  }
}

async function startLocalRuntime(): Promise<void> {
  if (isDesktopPlatform()) {
    try {
      await invokeDesktopBridgeRequest({
        rpcMethod: "agentStart",
        ipcChannel: "agent:start",
      });
      return;
    } catch (error) {
      try {
        await client.getAuthStatus();
        return;
      } catch {
        throw error;
      }
    }
  }
  await startMobileLocalAgent();
}

async function waitForAgentApi(): Promise<void> {
  const deadline = Date.now() + FIRST_RUN_AGENT_WAIT_MS;
  let delayMs = 750;
  while (Date.now() < deadline) {
    try {
      await client.getAuthStatus();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(Math.round(delayMs * 1.35), 4_000);
    }
  }
  throw new Error(
    "The agent API did not become ready before the first-run deadline.",
  );
}

function normalizeRemoteTarget(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a remote agent URL.");
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid remote agent URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Remote agents must use HTTP or HTTPS.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

export function useFirstRunController(): FirstRunController {
  const {
    completeFirstRun,
    elizaCloudConnected,
    elizaCloudLoginBusy,
    elizaCloudLoginError,
    handleCloudLogin,
    firstRunName,
    setActionNotice,
    setState,
    uiLanguage,
  } = useApp();
  const initialRuntimeTarget = React.useMemo(readFirstRunRuntimeTarget, []);
  // Desktop cloud-only opt-in: branding.cloudOnly is set from the injected
  // __ELIZA_DESKTOP_RUNTIME_MODE__ signal (api-base-owner → main.tsx branding).
  // When on, the runtime is forced to cloud and the Local/Remote options are
  // hidden. Off (the default) everywhere else, so web/mobile/default-desktop are
  // unchanged.
  const cloudOnly = Boolean(getBootConfig().branding?.cloudOnly);
  const initialDraft = React.useMemo<FirstRunProfileDraft>(
    () => ({
      agentName: normalizeFirstRunName(firstRunName) || "Eliza",
      runtime: cloudOnly ? "cloud" : (initialRuntimeTarget ?? "cloud"),
      localInference: "all-local",
      remoteApiBase: "",
      remoteToken: "",
    }),
    [cloudOnly, initialRuntimeTarget, firstRunName],
  );
  const persistedFirstRunState = React.useMemo(() => {
    const state = initialRuntimeTarget
      ? null
      : loadPersistedFirstRunState(initialDraft);
    return cloudOnly && state ? normalizeCloudOnlyFirstRunState(state) : state;
  }, [cloudOnly, initialDraft, initialRuntimeTarget]);
  const [step, setStepState] = React.useState<FirstRunStep>(() => {
    if (cloudOnly) return "runtime";
    if (persistedFirstRunState) return persistedFirstRunState.step;
    if (!cloudOnly && initialRuntimeTarget === "remote") return "remote";
    return "runtime";
  });
  const localRuntimeAvailable =
    React.useMemo(canSelectLocalRuntime, []) && !cloudOnly;
  const [draft, setDraft] = React.useState<FirstRunProfileDraft>(() => {
    const resolved = persistedFirstRunState?.draft ?? initialDraft;
    if (cloudOnly)
      return normalizeCloudOnlyFirstRunState({
        step: "runtime",
        draft: resolved,
      }).draft;
    if (!localRuntimeAvailable && resolved.runtime === "local") {
      return { ...resolved, runtime: "cloud" };
    }
    return resolved;
  });
  const [busyText, setBusyText] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [voice, setVoice] = React.useState<FirstRunVoiceState>(() => ({
    supported:
      isFirstRunVoiceInputSupported() || isFirstRunVoiceOutputSupported(),
    listening: false,
    speaking: false,
    transcript: "",
    error: isFirstRunVoiceInputSupported()
      ? null
      : "Voice input is not available in this renderer.",
  }));
  // Voice-first onboarding needs microphone access before the listening step.
  // The hook wraps the cross-platform permission client and degrades to a
  // getUserMedia probe when that client is unavailable; it never throws.
  const microphone = useMicrophonePermission();
  const voiceCaptureRef = React.useRef<VoiceCaptureHandle | null>(null);
  const voiceCaptureGenerationRef = React.useRef(0);
  const voiceOutputActiveRef = React.useRef(false);
  const firstRunAudioRef = React.useRef<HTMLAudioElement | null>(null);
  const activePromptTextRef = React.useRef("");
  const listenAfterSpeechTimerRef = React.useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const promptSequenceRef = React.useRef(0);
  const stepRef = React.useRef(step);
  const draftRef = React.useRef(draft);

  React.useEffect(() => {
    stepRef.current = step;
  }, [step]);

  React.useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  React.useEffect(() => {
    if (busyText) return;
    savePersistedFirstRunState({ step, draft });
  }, [busyText, draft, step]);

  const clearListenAfterSpeechTimer = React.useCallback(() => {
    const timer = listenAfterSpeechTimerRef.current;
    if (!timer) return;
    clearTimeout(timer);
    listenAfterSpeechTimerRef.current = null;
  }, []);

  const stopFirstRunAudio = React.useCallback(() => {
    const element = firstRunAudioRef.current;
    if (!element) return;
    firstRunAudioRef.current = null;
    element.onended = null;
    element.onerror = null;
    element.onplay = null;
    element.pause();
    if (element.src) URL.revokeObjectURL(element.src);
  }, []);

  const cancelVoiceCapture = React.useCallback(() => {
    clearListenAfterSpeechTimer();
    voiceCaptureGenerationRef.current += 1;
    const current = voiceCaptureRef.current;
    if (!current) return;
    current.dispose();
    if (voiceCaptureRef.current === current) {
      voiceCaptureRef.current = null;
    }
    setVoice((state) => ({
      ...state,
      listening: false,
      error: null,
    }));
  }, [clearListenAfterSpeechTimer]);

  React.useEffect(
    () => () => {
      clearListenAfterSpeechTimer();
      stopFirstRunAudio();
      voiceCaptureRef.current?.dispose();
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    },
    [clearListenAfterSpeechTimer, stopFirstRunAudio],
  );

  const setStep = React.useCallback(
    (next: FirstRunStep) => {
      setStepState(cloudOnly && next === "remote" ? "runtime" : next);
    },
    [cloudOnly],
  );

  const updateDraft = React.useCallback<FirstRunDraftUpdate>(
    (key, value) =>
      setDraft((current) => {
        const next = { ...current, [key]: value };
        const resolved = cloudOnly
          ? normalizeCloudOnlyFirstRunState({ step: "runtime", draft: next })
              .draft
          : next;
        draftRef.current = resolved;
        return resolved;
      }),
    [cloudOnly],
  );

  const syncIdentity = React.useCallback(
    (sourceDraft: FirstRunProfileDraft) => {
      const agentName = normalizeFirstRunName(sourceDraft.agentName);
      if (agentName) {
        setState("firstRunName", agentName);
      }
    },
    [setState],
  );

  const submitFirstRun = React.useCallback(
    async (sourceDraft: FirstRunProfileDraft, runtime: FirstRunRuntime) => {
      const plan = buildFirstRunSubmitPlan({
        draft: { ...sourceDraft, runtime },
        uiLanguage,
      });
      await client.submitFirstRun(plan.payload);
      if (plan.runtimeConfig.needsProviderSetup) {
        setActionNotice(
          "Choose a model provider in Settings before sending the first message.",
          "info",
          7000,
        );
      }
    },
    [setActionNotice, uiLanguage],
  );

  const finishLocal = React.useCallback(
    async (sourceDraft: FirstRunProfileDraft) => {
      // Local + cloud-inference (hybrid) routes inference through Eliza Cloud,
      // so connect the cloud account first; the user starts again once linked.
      if (firstRunNeedsCloudConnect(sourceDraft, elizaCloudConnected)) {
        syncIdentity(sourceDraft);
        setError(null);
        setState("firstRunRuntimeTarget", "elizacloud-hybrid");
        setState("firstRunProvider", "elizacloud");
        const authWindow = preOpenWindow();
        await handleCloudLogin(authWindow);
        return;
      }
      syncIdentity(sourceDraft);
      setError(null);
      setBusyText("Starting local agent");
      const apiBase = resolveFirstRunLocalAgentApiBase();
      client.setBaseUrl(apiBase);
      client.setToken(
        isAndroid || isIOS ? readSyncOnDeviceAgentBearer() : null,
      );
      await startLocalRuntime();
      await waitForAgentApi();
      if (isAndroid || isIOS) {
        savePersistedActiveServer({
          id: isAndroid
            ? ANDROID_LOCAL_AGENT_SERVER_ID
            : MOBILE_LOCAL_AGENT_SERVER_ID,
          kind: "remote",
          label: isAndroid
            ? ANDROID_LOCAL_AGENT_LABEL
            : MOBILE_LOCAL_AGENT_LABEL,
          apiBase,
        });
        addAgentProfile({
          kind: "remote",
          label: isAndroid
            ? ANDROID_LOCAL_AGENT_LABEL
            : MOBILE_LOCAL_AGENT_LABEL,
          apiBase,
        });
      } else {
        savePersistedActiveServer({
          id: "local:desktop",
          kind: "remote",
          label: "Local agent",
          apiBase,
        });
        addAgentProfile({ kind: "remote", label: "Local agent", apiBase });
      }
      persistMobileRuntimeModeForServerTarget("local");
      setState("firstRunRuntimeTarget", "local");
      setBusyText("Saving first-run profile");
      await submitFirstRun(sourceDraft, "local");
      if (firstRunDownloadsLocalModel(sourceDraft.localInference)) {
        void autoDownloadRecommendedLocalModelInBackground(apiBase);
      }
      clearPersistedFirstRunState();
      setBusyText(null);
      completeFirstRun("chat", { launchCompanionOverlay: true });
    },
    [
      completeFirstRun,
      elizaCloudConnected,
      handleCloudLogin,
      setState,
      submitFirstRun,
      syncIdentity,
    ],
  );

  const finishRemote = React.useCallback(
    async (sourceDraft: FirstRunProfileDraft) => {
      syncIdentity(sourceDraft);
      setError(null);
      const apiBase = normalizeRemoteTarget(sourceDraft.remoteApiBase);
      const accessToken = sourceDraft.remoteToken.trim();
      setBusyText("Checking remote agent");
      client.setBaseUrl(apiBase);
      client.setToken(accessToken || null);
      const auth = await client.getAuthStatus();
      if (auth.required && !accessToken) {
        throw new Error("This remote agent requires an access token.");
      }
      await client.getFirstRunStatus();
      savePersistedActiveServer({
        id: `remote:${apiBase}`,
        kind: "remote",
        label: apiBase,
        apiBase,
        ...(accessToken ? { accessToken } : {}),
      });
      addAgentProfile({
        kind: "remote",
        label: apiBase,
        apiBase,
        ...(accessToken ? { accessToken } : {}),
      });
      persistMobileRuntimeModeForServerTarget("remote");
      setState("firstRunRuntimeTarget", "remote");
      setState("firstRunRemoteApiBase", apiBase);
      setState("firstRunRemoteToken", accessToken);
      setState("firstRunRemoteConnected", true);
      setBusyText("Saving first-run profile");
      await submitFirstRun(sourceDraft, "remote");
      clearPersistedFirstRunState();
      setBusyText(null);
      completeFirstRun("chat", { launchCompanionOverlay: true });
    },
    [completeFirstRun, setState, submitFirstRun, syncIdentity],
  );

  const finishCloud = React.useCallback(
    async (sourceDraft: FirstRunProfileDraft) => {
      syncIdentity(sourceDraft);
      setError(null);
      setState("firstRunRuntimeTarget", firstRunRuntimeTarget("cloud"));
      setState("firstRunProvider", "elizacloud");
      let cloudConnectedForFinish = elizaCloudConnected;
      if (!cloudConnectedForFinish) {
        const cloudStatus = await client.getCloudStatus().catch(() => null);
        cloudConnectedForFinish = isCloudStatusAuthenticated(
          Boolean(cloudStatus?.connected),
          cloudStatus?.reason,
        );
      }
      if (firstRunNeedsCloudConnect(sourceDraft, cloudConnectedForFinish)) {
        const authWindow = preOpenWindow();
        await handleCloudLogin(authWindow);
        return;
      }
      setBusyText("Provisioning cloud agent");
      const authToken = String(
        (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__ ??
          "",
      ).trim();
      if (!authToken) {
        throw new Error("Eliza Cloud authentication required.");
      }
      const plan = buildFirstRunSubmitPlan({
        draft: { ...sourceDraft, runtime: "cloud" },
        uiLanguage,
      });
      const name =
        typeof plan.payload.name === "string" ? plan.payload.name : "Milady";
      const bio = Array.isArray(plan.payload.bio)
        ? plan.payload.bio.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : ["An autonomous AI agent."];
      const provisionedAgent = await client.provisionCloudSandbox({
        cloudApiBase:
          getBootConfig().cloudApiBase || "https://www.elizacloud.ai",
        authToken,
        name,
        bio,
        onProgress: () => {},
      });
      client.setBaseUrl(provisionedAgent.bridgeUrl);
      client.setToken(authToken);
      const activeServer = createPersistedActiveServer({
        kind: "cloud",
        apiBase: provisionedAgent.bridgeUrl,
        accessToken: authToken,
      });
      savePersistedActiveServer(activeServer);
      addAgentProfile({
        kind: "cloud",
        label: activeServer.label,
        ...(activeServer.apiBase ? { apiBase: activeServer.apiBase } : {}),
        ...(activeServer.accessToken
          ? { accessToken: activeServer.accessToken }
          : {}),
      });
      persistMobileRuntimeModeForServerTarget("elizacloud");
      setBusyText("Saving first-run profile");
      await client.submitFirstRun(plan.payload);
      clearPersistedFirstRunState();
      setBusyText(null);
      completeFirstRun("chat", { launchCompanionOverlay: true });
    },
    [
      completeFirstRun,
      elizaCloudConnected,
      handleCloudLogin,
      setState,
      syncIdentity,
      uiLanguage,
    ],
  );

  const finishRuntimeForDraft = React.useCallback(
    async (sourceDraft: FirstRunProfileDraft) => {
      const normalizedDraft = cloudOnly
        ? normalizeCloudOnlyFirstRunState({
            step: "runtime",
            draft: sourceDraft,
          }).draft
        : sourceDraft;
      const validation = validateFirstRunSubmitDraft(normalizedDraft);
      if (!validation.valid) {
        setStep(validation.step);
        setError(validation.message);
        return;
      }
      try {
        if (normalizedDraft.runtime === "remote") {
          await finishRemote(normalizedDraft);
          return;
        }
        if (normalizedDraft.runtime === "cloud") {
          await finishCloud(normalizedDraft);
          return;
        }
        await finishLocal(normalizedDraft);
      } catch (err) {
        setBusyText(null);
        setError(
          err instanceof Error ? err.message : "First-run setup failed.",
        );
      }
    },
    [cloudOnly, finishCloud, finishLocal, finishRemote, setStep],
  );

  const finishRuntime = React.useCallback(
    async () => finishRuntimeForDraft(draft),
    [draft, finishRuntimeForDraft],
  );

  const stopVoice = React.useCallback(async () => {
    clearListenAfterSpeechTimer();
    const current = voiceCaptureRef.current;
    if (!current) return;
    setVoice((state) => ({
      ...state,
      listening: false,
      error: null,
    }));
    try {
      await current.stop();
    } catch (err) {
      current.dispose();
      if (voiceCaptureRef.current === current) {
        voiceCaptureRef.current = null;
      }
      setVoice((state) => ({
        ...state,
        listening: false,
        error: formatFirstRunVoiceError(err),
      }));
    }
  }, [clearListenAfterSpeechTimer]);

  const applyVoiceTranscript = React.useCallback(
    (transcript: string) => {
      const update = applyFirstRunVoiceTranscript({
        step: stepRef.current,
        draft: draftRef.current,
        transcript,
      });
      const normalizedUpdate = cloudOnly
        ? {
            ...update,
            ...normalizeCloudOnlyFirstRunState({
              step: update.step,
              draft: update.draft,
            }),
          }
        : update;
      draftRef.current = normalizedUpdate.draft;
      stepRef.current = normalizedUpdate.step;
      setDraft(normalizedUpdate.draft);
      setStep(normalizedUpdate.step);
      setError(null);
      if (normalizedUpdate.action === "finish") {
        void finishRuntimeForDraft(normalizedUpdate.draft);
      }
    },
    [cloudOnly, finishRuntimeForDraft, setStep],
  );

  const startVoice = React.useCallback(async () => {
    if (voiceOutputActiveRef.current) return;

    const asrProvider = resolveFirstRunAsrProvider();
    if (!asrProvider) {
      setVoice((current) => ({
        ...current,
        supported: isFirstRunVoiceOutputSupported(),
        listening: false,
        error: "Voice input is not available in this renderer.",
      }));
      return;
    }

    if (voiceCaptureRef.current?.isActive()) return;

    const voiceReadiness =
      asrProvider === "local-inference"
        ? await prepareFirstRunVoiceAndTranscription()
        : null;
    if (voiceReadiness && voiceReadiness.status !== "ready") {
      setVoice((current) => ({
        ...current,
        supported: true,
        listening: false,
        error: voiceReadiness.message || FIRST_RUN_VOICE_PREPARING_MESSAGE,
      }));
      return;
    }
    if (voiceOutputActiveRef.current) return;
    if (voiceCaptureRef.current?.isActive()) return;

    voiceCaptureRef.current?.dispose();
    const captureGeneration = voiceCaptureGenerationRef.current + 1;
    voiceCaptureGenerationRef.current = captureGeneration;
    const capture = createVoiceCapture({
      asrProvider,
      lang: resolveFirstRunVoiceLocale(uiLanguage),
      localAsrAutoStop:
        asrProvider === "local-inference"
          ? FIRST_RUN_LOCAL_ASR_AUTO_STOP
          : undefined,
      onTranscript: (segment) => {
        if (voiceCaptureGenerationRef.current !== captureGeneration) return;
        if (voiceOutputActiveRef.current) return;
        if (
          segment.final &&
          isFirstRunPromptEcho({
            promptText: activePromptTextRef.current,
            transcript: segment.text,
          })
        ) {
          setVoice((current) => ({
            ...current,
            transcript: "",
            error: null,
          }));
          return;
        }
        setVoice((current) => ({
          ...current,
          transcript: segment.text,
          error: null,
        }));
        if (segment.final) applyVoiceTranscript(segment.text);
      },
      onStateChange: (state: VoiceCaptureState, stateError?: Error) => {
        if (voiceCaptureGenerationRef.current !== captureGeneration) return;
        setVoice((current) => ({
          ...current,
          supported: true,
          listening: state === "starting" || state === "listening",
          error:
            state === "error" ? formatFirstRunVoiceError(stateError) : null,
        }));
      },
    });
    voiceCaptureRef.current = capture;
    try {
      await capture.start();
    } catch (err) {
      capture.dispose();
      if (voiceCaptureRef.current === capture) {
        voiceCaptureRef.current = null;
      }
      if (voiceCaptureGenerationRef.current !== captureGeneration) return;
      setVoice((current) => ({
        ...current,
        listening: false,
        error: formatFirstRunVoiceError(err),
      }));
    }
  }, [applyVoiceTranscript, uiLanguage]);

  const toggleVoice = React.useCallback(async () => {
    if (voiceCaptureRef.current?.isActive()) {
      await stopVoice();
      return;
    }
    await startVoice();
  }, [startVoice, stopVoice]);

  const onPromptReady = React.useCallback(
    (promptText: string, lineId: string) => {
      const sequence = promptSequenceRef.current + 1;
      promptSequenceRef.current = sequence;
      voiceCaptureGenerationRef.current += 1;
      activePromptTextRef.current = promptText;
      cancelVoiceCapture();
      setVoice((current) => ({
        ...current,
        transcript: "",
        error: isFirstRunVoiceInputSupported()
          ? null
          : "Voice input is not available in this renderer.",
      }));

      if (!isFirstRunVoiceOutputSupported()) {
        void startVoice();
        return;
      }

      voiceOutputActiveRef.current = true;
      window.speechSynthesis.cancel();
      stopFirstRunAudio();

      const markSpeaking = () => {
        if (promptSequenceRef.current !== sequence) return;
        setVoice((current) => ({
          ...current,
          supported: true,
          speaking: true,
        }));
      };
      const startListeningAfterSpeech = () => {
        if (promptSequenceRef.current !== sequence) return;
        voiceOutputActiveRef.current = false;
        setVoice((current) => ({ ...current, speaking: false }));
        clearListenAfterSpeechTimer();
        listenAfterSpeechTimerRef.current = setTimeout(() => {
          listenAfterSpeechTimerRef.current = null;
          if (promptSequenceRef.current !== sequence) return;
          void startVoice();
        }, FIRST_RUN_LISTEN_AFTER_SPEECH_DELAY_MS);
      };

      const speakWithBrowser = () => {
        if (promptSequenceRef.current !== sequence) return;
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(promptText);
        utterance.lang = resolveFirstRunVoiceLocale(uiLanguage);
        utterance.onstart = markSpeaking;
        utterance.onend = startListeningAfterSpeech;
        utterance.onerror = startListeningAfterSpeech;
        window.speechSynthesis.speak(utterance);
      };

      // Prefer the pre-generated OmniVoice preset; fall back to browser
      // speechSynthesis so onboarding never goes silent if the preset is not
      // yet generated (404), audio autoplay is blocked, etc.
      void (async () => {
        try {
          const audioData = await client.synthesizeFirstRunSpeech(lineId);
          if (promptSequenceRef.current !== sequence) return;
          const url = URL.createObjectURL(
            new Blob([audioData], { type: "audio/wav" }),
          );
          const element = new Audio(url);
          firstRunAudioRef.current = element;
          const release = () => {
            URL.revokeObjectURL(url);
            if (firstRunAudioRef.current === element) {
              firstRunAudioRef.current = null;
            }
          };
          element.onplay = markSpeaking;
          element.onended = () => {
            release();
            startListeningAfterSpeech();
          };
          element.onerror = () => {
            release();
            speakWithBrowser();
          };
          await element.play();
        } catch {
          if (promptSequenceRef.current !== sequence) return;
          speakWithBrowser();
        }
      })();
    },
    [
      cancelVoiceCapture,
      clearListenAfterSpeechTimer,
      startVoice,
      stopFirstRunAudio,
      uiLanguage,
    ],
  );

  const goBack = React.useCallback(() => {
    const previous = previousFirstRunStep(step);
    if (previous) setStep(previous);
  }, [setStep, step]);

  const submitting = busyText !== null || elizaCloudLoginBusy;
  const primaryLabel =
    step === "runtime"
      ? firstRunNeedsCloudConnect(draft, elizaCloudConnected)
        ? "Connect"
        : "Start"
      : step === "remote"
        ? "Start"
        : "Continue";

  return {
    step,
    draft,
    localRuntimeAvailable,
    cloudOnly,
    elizaCloudConnected,
    submitting,
    busyText,
    error,
    cloudError: elizaCloudLoginError,
    voice,
    microphone,
    primaryLabel,
    canBack: previousFirstRunStep(step) !== null && !submitting,
    updateDraft,
    setStep,
    goBack,
    finishRuntime,
    startVoice,
    stopVoice,
    toggleVoice,
    onPromptReady,
  };
}
