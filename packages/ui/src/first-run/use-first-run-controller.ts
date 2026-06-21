import { Capacitor } from "@capacitor/core";
import * as React from "react";
import { client } from "../api";
import {
  getCloudAuthToken,
  isDirectCloudSharedAgentBase,
} from "../api/client-cloud";
import type { CloudCompatAgent } from "../api/client-types-cloud";
import { getDesktopRuntimeMode, invokeDesktopBridgeRequest } from "../bridge";
import { getBootConfig } from "../config/boot-config";
import { dispatchCloudHandoffPhase } from "../events";
import {
  canSelectLocalRuntime,
  isAndroid,
  isDesktopPlatform,
  isIOS,
} from "../platform/init";
import {
  addAgentProfile,
  createPersistedActiveServer,
  loadPersistedActiveServer,
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

/** Phase of the post-sign-in cloud agent picker (the "pick-agent" step). */
export type FirstRunPickerPhase = "loading" | "ready" | "error" | "binding";

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
  // Post-sign-in cloud agent picker ("pick-agent" step) state + actions.
  pickerAgents: CloudCompatAgent[];
  pickerPhase: FirstRunPickerPhase;
  pickerError: string | null;
  pickerActiveAgentId: string | null;
  pickerBindingId: string | null;
  onPickAgent: (agentId: string) => void;
  onCreateNewAgent: () => void;
  onRetryPicker: () => void;
  onBackFromPicker: () => void;
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
      const desktopRuntimeMode = await getDesktopRuntimeMode().catch(
        () => null,
      );
      if (desktopRuntimeMode && desktopRuntimeMode.mode !== "local") {
        return;
      }
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

/**
 * The cloud agent id currently bound as the active server, if any. Mirrors
 * CloudAgentsSection's parse: only a `cloud:`-prefixed id whose tail is a real
 * agent id (older builds mistakenly stored a URL) counts.
 */
function readActiveCloudAgentId(): string | null {
  const active = loadPersistedActiveServer();
  if (active?.kind !== "cloud") return null;
  const id = active.id?.startsWith("cloud:")
    ? active.id.slice("cloud:".length)
    : "";
  return id && !id.includes("/") ? id : null;
}

/**
 * Newest-first, running-prioritized order — mirrors pickPreferredCloudAgent
 * (client-cloud.ts) so the picker's top-of-list matches the silent auto-default.
 */
function sortCloudAgentsForPicker(
  agents: CloudCompatAgent[],
): CloudCompatAgent[] {
  return [...agents]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .sort((a, b) => {
      const aRunning = a.status === "running" ? 0 : 1;
      const bRunning = b.status === "running" ? 0 : 1;
      return aRunning - bRunning;
    });
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
    showActionBanner,
    setTab,
    setState,
    switchAgentProfile,
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
  // Post-sign-in cloud agent picker state. Populated by finishCloud after the
  // OAuth gate passes; consumed by the AgentPicker rendered on the "pick-agent"
  // step. Never persisted (the agent list is in-memory only).
  const [pickerAgents, setPickerAgents] = React.useState<CloudCompatAgent[]>(
    [],
  );
  const [pickerPhase, setPickerPhase] =
    React.useState<FirstRunPickerPhase>("loading");
  const [pickerError, setPickerError] = React.useState<string | null>(null);
  const [pickerBindingId, setPickerBindingId] = React.useState<string | null>(
    null,
  );
  const [pickerActiveAgentId] = React.useState<string | null>(
    readActiveCloudAgentId,
  );
  // Synchronous bind guard: pickerPhase state updates are deferred to render, so
  // a double-tap of Create/Pick in the same tick would both pass the
  // `pickerPhase === "binding"` check and mint two agents. This ref flips
  // immediately so the second call early-returns.
  const pickerBindingRef = React.useRef(false);
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
    // "pick-agent" is a transient step whose agent list lives only in memory;
    // persisting it would restore a picker with no agents on reload. Skip it
    // (loadPersistedFirstRunState also coerces any stale "pick-agent" → runtime).
    if (step === "pick-agent") return;
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
    (key, value) => {
      // Update draftRef SYNCHRONOUSLY (not inside the setDraft updater, which
      // React defers to render). Callers that update a field and immediately
      // finish the flow in the same tick — the onboarding "Local models" tap
      // does updateDraft("runtime","local") then finishRuntime(), which reads
      // draftRef.current — would otherwise act on the stale previous runtime
      // and provision the wrong target. Mirrors applyVoiceTranscript's pattern.
      const next = { ...draftRef.current, [key]: value };
      const resolved = cloudOnly
        ? normalizeCloudOnlyFirstRunState({ step: "runtime", draft: next })
            .draft
        : next;
      draftRef.current = resolved;
      setDraft(resolved);
    },
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
        showActionBanner({
          text: "Choose a model provider in Settings before sending the first message.",
          actionLabel: "Open Settings",
          onAction: () => setTab("settings"),
        });
      }
    },
    [showActionBanner, setTab, uiLanguage],
  );

  const finishLocal = React.useCallback(
    async (sourceDraft: FirstRunProfileDraft) => {
      syncIdentity(sourceDraft);
      setError(null);
      // Local + cloud-inference (hybrid) routes inference through Eliza Cloud, so
      // connect the cloud account first. Mirror finishCloud: once the in-app
      // Steward sign-in resolves and the connection is confirmed, fall through
      // and start the local agent in the same run (no second tap). If login is
      // still pending (legacy browser handoff), stop here — the sign-in link is
      // surfaced and the user re-triggers once signed in.
      if (firstRunNeedsCloudConnect(sourceDraft, elizaCloudConnected)) {
        setState("firstRunRuntimeTarget", "elizacloud-hybrid");
        setState("firstRunProvider", "elizacloud");
        const authWindow = preOpenWindow();
        await handleCloudLogin(authWindow);
        const cloudStatus = await client.getCloudStatus().catch(() => null);
        let cloudConnectedForFinish = isCloudStatusAuthenticated(
          Boolean(cloudStatus?.connected),
          cloudStatus?.reason,
        );
        if (!cloudConnectedForFinish && getCloudAuthToken(client)) {
          cloudConnectedForFinish = true;
        }
        if (!cloudConnectedForFinish) {
          return;
        }
      }
      const serverTarget = firstRunRuntimeTarget(
        sourceDraft.runtime,
        sourceDraft.localInference,
      );
      // Persist the runtime mode BEFORE starting/awaiting the on-device agent.
      // The iOS native transport classifies the app from
      // `eliza:mobile-runtime-mode`; while it is still unset, a production build
      // defaults to a pure-cloud runtime (isNativeIosCloudRuntime) and BLOCKS
      // local-agent IPC, so every waitForAgentApi probe is rejected before it
      // can reach the engine and "Starting local agent" hangs to the deadline.
      // Setting the mode first makes the transport treat local/cloud-hybrid as
      // on-device runtimes and route the probe through the bundled agent.
      persistMobileRuntimeModeForServerTarget(serverTarget);
      setState("firstRunRuntimeTarget", serverTarget);
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
        // The remote needs auth and the user supplied no pre-shared token. If
        // the host has device pairing enabled, hand off to the pairing flow
        // instead of dead-ending: persist the remote as the active profile and
        // switch to it, which drives the startup poll into PairingView (where
        // the user enters the short code printed on the host — see
        // startup-phase-poll BACKEND_AUTH_REQUIRED → pairing-required). Only a
        // pairing-DISABLED remote genuinely needs a connection key typed here.
        if (auth.pairingEnabled) {
          const profile = addAgentProfile({
            kind: "remote",
            label: apiBase,
            apiBase,
          });
          // Persist the remote as the ACTIVE SERVER too (not just an agent
          // profile). After the user enters the code, handlePairingSubmit →
          // persistPairedToken attaches the minted token to the active server
          // and reloads; without an active server here that reload boots into
          // fresh onboarding instead of the now-paired remote agent.
          savePersistedActiveServer({
            id: `remote:${apiBase}`,
            kind: "remote",
            label: apiBase,
            apiBase,
          });
          persistMobileRuntimeModeForServerTarget("remote");
          setState("firstRunRuntimeTarget", "remote");
          setState("firstRunRemoteApiBase", apiBase);
          clearPersistedFirstRunState();
          setBusyText(null);
          switchAgentProfile(profile.id);
          return;
        }
        throw new Error(
          "This remote agent requires an access token. Enter the host's connection key, or enable pairing on the host.",
        );
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
    [
      completeFirstRun,
      setState,
      submitFirstRun,
      switchAgentProfile,
      syncIdentity,
    ],
  );

  // The provisioning tail of the cloud flow, extracted so both the silent
  // auto-create path (0 agents) and the picker's pick / create-new actions feed
  // their choice (preferAgentId / forceCreate) into the SAME provisioning call.
  // authToken is threaded in as a param so the picker callbacks don't re-derive
  // it. Kept byte-identical to the old finishCloud tail apart from (a) authToken
  // param, (b) preferAgentId/forceCreate spread, (c) onProgress → setBusyText.
  const finishCloudWithSelection = React.useCallback(
    async (
      sourceDraft: FirstRunProfileDraft,
      authToken: string,
      opts: { preferAgentId?: string | null; forceCreate?: boolean },
    ) => {
      setBusyText("Setting up your cloud agent");
      const plan = buildFirstRunSubmitPlan({
        draft: { ...sourceDraft, runtime: "cloud" },
        uiLanguage,
      });
      const name =
        typeof plan.payload.name === "string" ? plan.payload.name : "Eliza";
      const bio = Array.isArray(plan.payload.bio)
        ? plan.payload.bio.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : ["An autonomous AI agent."];
      // Reuse an existing cloud agent when the user has one, instead of minting a
      // brand-new agent on every sign-in (the cause of the "11 agents created
      // today" churn). selectOrProvisionCloudAgent returns a valid per-agent REST
      // adapter base (.../agents/<id>), never the agent-id-less collection URL
      // that made first-run's /api/* probes 404 ("Backend Unreachable").
      const selectedAgent = await client.selectOrProvisionCloudAgent({
        cloudApiBase:
          getBootConfig().cloudApiBase || "https://www.elizacloud.ai",
        authToken,
        name,
        bio,
        ...(opts.preferAgentId ? { preferAgentId: opts.preferAgentId } : {}),
        ...(opts.forceCreate ? { forceCreate: true } : {}),
        onProgress: (status, detail) => setBusyText(detail ?? status),
      });
      const cloudAgentApiBase = selectedAgent.apiBase;
      client.setBaseUrl(cloudAgentApiBase);
      client.setToken(authToken);
      // Persist the concrete agent id (cloud:<agentId>) so the next boot restores
      // this exact agent — and so the apiBase can be re-derived from the id if it
      // is ever lost (startup-phase-restore backfill).
      const activeServer = createPersistedActiveServer({
        kind: "cloud",
        // Key the persisted server by the stable cloud agent id, not the
        // ephemeral bridge URL: a reprovision/restart hands back a new bridge
        // URL, so an apiBase-keyed id would orphan the saved server (and the
        // user's chat continuity). Mirrors useFirstRunCallbacks.
        id: `cloud:${selectedAgent.agentId}`,
        apiBase: cloudAgentApiBase,
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
      // A shared-runtime cloud agent has no agent server, so POST /api/first-run
      // (submitFirstRun) 404s — there is no per-agent first-run config store to
      // write to, and the agent is already provisioned + named cloud-side. Don't
      // let that 404 throw and strand onboarding before completeFirstRun() runs;
      // tolerate it for a shared-agent base and finish the transition to chat.
      try {
        await client.submitFirstRun(plan.payload);
      } catch (err) {
        if (!isDirectCloudSharedAgentBase(client.getBaseUrl())) throw err;
      }
      clearPersistedFirstRunState();
      setBusyText(null);
      completeFirstRun("chat", { launchCompanionOverlay: true });

      // Seamless shared→personal handoff. A freshly created cloud agent serves
      // the user from the shared REST adapter while its dedicated container
      // boots (selectedAgent.created with no bridge URL yet). In the background,
      // once the container is reachable, copy the conversation the user built on
      // the shared adapter into it and switch the live client over — no waiting,
      // no lost history. Best-effort: on failure the user stays on the shared
      // adapter, which keeps working.
      if (selectedAgent.created && !selectedAgent.bridgeUrl) {
        const handoffAgentId = selectedAgent.agentId;
        // Tell the UI a migration is in flight instead of swapping silently.
        dispatchCloudHandoffPhase({
          agentId: handoffAgentId,
          phase: "migrating",
        });
        void client
          .startCloudAgentHandoff({
            agentId: handoffAgentId,
            sharedApiBase: cloudAgentApiBase,
            // The shared adapter keeps one canonical conversation per agent id.
            conversationId: handoffAgentId,
            cloudApiBase:
              getBootConfig().cloudApiBase || "https://www.elizacloud.ai",
            authToken,
            onSwitch: (containerBase) => {
              client.setBaseUrl(containerBase);
              client.setToken(authToken);
              const switched = createPersistedActiveServer({
                kind: "cloud",
                id: `cloud:${handoffAgentId}`,
                apiBase: containerBase,
                accessToken: authToken,
              });
              savePersistedActiveServer(switched);
              const profile = addAgentProfile({
                kind: "cloud",
                label: switched.label,
                apiBase: containerBase,
                accessToken: authToken,
              });
              switchAgentProfile(profile.id);
            },
          })
          // Stop discarding the ConversationHandoffResult: surface each terminal
          // status (switched | switched-empty | timed-out | failed) as a typed
          // handoff phase so the UI can render real progress and an honest
          // failure notice. Still best-effort — the shared adapter keeps working
          // regardless of outcome.
          .then((result) => {
            dispatchCloudHandoffPhase({
              agentId: handoffAgentId,
              phase: result.status,
              imported: result.imported,
              ...(result.error ? { error: result.error } : {}),
            });
          })
          .catch((err: unknown) => {
            dispatchCloudHandoffPhase({
              agentId: handoffAgentId,
              phase: "failed",
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }
    },
    [completeFirstRun, switchAgentProfile, uiLanguage],
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
        const cloudStatus = await client.getCloudStatus().catch(() => null);
        cloudConnectedForFinish = isCloudStatusAuthenticated(
          Boolean(cloudStatus?.connected),
          cloudStatus?.reason,
        );
        // Cloud = Steward: a present session token is authoritative even if the
        // status proxy lags right after sign-in.
        if (!cloudConnectedForFinish && getCloudAuthToken(client)) {
          cloudConnectedForFinish = true;
        }
        if (!cloudConnectedForFinish) {
          return;
        }
      }
      // Cloud = Steward everywhere (DECISIONS.md D3): the cloud agent is
      // provisioned with the Steward session JWT (same-origin cookie+JWT on web,
      // Bearer-from-localStorage on native), not a device-code token. Only enter
      // the picker once a token is present — fetching the agent list without one
      // would falsely show empty/error. Surface (not throw) so onboarding stays.
      const authToken = getCloudAuthToken(client) ?? "";
      if (!authToken) {
        setError("Eliza Cloud authentication required.");
        return;
      }
      // Interpose the picker: show the user's existing cloud agents (choose one
      // or create new) instead of silently auto-reusing/creating.
      pickerBindingRef.current = false;
      setStep("pick-agent");
      setPickerPhase("loading");
      setPickerError(null);
      setPickerBindingId(null);
      let list: { success: boolean; data: CloudCompatAgent[]; error?: string };
      try {
        list = await client.getCloudCompatAgents();
      } catch (err) {
        list = {
          success: false,
          data: [],
          error:
            err instanceof Error ? err.message : "Could not load your agents.",
        };
      }
      if (!list.success) {
        // Hold on an error state — do NOT fall through to auto-create. This is
        // the fix for the silent .catch churn that minted duplicate agents.
        setPickerPhase("error");
        setPickerError(list.error ?? "Could not load your agents. Try again.");
        return;
      }
      if (list.data.length === 0) {
        // Brand-new user: skip the picker and auto-create (current behavior, no
        // extra click, no dead one-item-less UI).
        await finishCloudWithSelection(sourceDraft, authToken, {
          forceCreate: false,
        });
        return;
      }
      // >=1 agents: render the picker (newest-first, running-prioritized to
      // mirror pickPreferredCloudAgent). Leave busyText null so it is interactive.
      setPickerAgents(sortCloudAgentsForPicker(list.data));
      setPickerPhase("ready");
    },
    [
      elizaCloudConnected,
      finishCloudWithSelection,
      handleCloudLogin,
      setState,
      setStep,
      syncIdentity,
    ],
  );

  // Picker actions. All are inert while a bind is in flight (pickerPhase ===
  // "binding") so a double-tap can't mint a duplicate agent. They re-derive the
  // auth token (already present — the picker is only reachable past the gate).
  const onPickAgent = React.useCallback(
    async (agentId: string) => {
      if (pickerBindingRef.current) return;
      // Already bound: a redundant rebind/reload buys nothing.
      if (agentId === pickerActiveAgentId) return;
      const authToken = getCloudAuthToken(client) ?? "";
      if (!authToken) {
        setPickerPhase("error");
        setPickerError("Eliza Cloud authentication required.");
        return;
      }
      pickerBindingRef.current = true;
      setPickerPhase("binding");
      setPickerBindingId(agentId);
      try {
        await finishCloudWithSelection(draftRef.current, authToken, {
          preferAgentId: agentId,
        });
      } catch (err) {
        pickerBindingRef.current = false;
        setBusyText(null);
        setPickerPhase("error");
        setPickerError(
          err instanceof Error
            ? err.message
            : "Could not connect to that agent.",
        );
        setPickerBindingId(null);
      }
    },
    [finishCloudWithSelection, pickerActiveAgentId],
  );

  const onCreateNewAgent = React.useCallback(async () => {
    if (pickerBindingRef.current) return;
    const authToken = getCloudAuthToken(client) ?? "";
    if (!authToken) {
      setPickerPhase("error");
      setPickerError("Eliza Cloud authentication required.");
      return;
    }
    pickerBindingRef.current = true;
    setPickerPhase("binding");
    setPickerBindingId(null);
    try {
      await finishCloudWithSelection(draftRef.current, authToken, {
        forceCreate: true,
      });
    } catch (err) {
      pickerBindingRef.current = false;
      setBusyText(null);
      setPickerPhase("error");
      setPickerError(
        err instanceof Error ? err.message : "Could not create a new agent.",
      );
    }
  }, [finishCloudWithSelection]);

  const onRetryPicker = React.useCallback(async () => {
    if (pickerBindingRef.current) return;
    await finishCloud(draftRef.current);
  }, [finishCloud]);

  const onBackFromPicker = React.useCallback(() => {
    if (pickerBindingRef.current) return;
    // Keep the Steward session; return to the runtime choice (the only
    // non-remote fallback step). There is no "proceed without an agent" exit —
    // completeFirstRun needs a bound apiBase.
    setStep("runtime");
    setPickerPhase("loading");
    setPickerError(null);
    setPickerBindingId(null);
  }, [setStep]);

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
    async () => finishRuntimeForDraft(draftRef.current),
    [finishRuntimeForDraft],
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
    pickerAgents,
    pickerPhase,
    pickerError,
    pickerActiveAgentId,
    pickerBindingId,
    onPickAgent,
    onCreateNewAgent,
    onRetryPicker,
    onBackFromPicker,
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
