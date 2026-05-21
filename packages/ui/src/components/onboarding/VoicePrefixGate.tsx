/**
 * VoicePrefixGate — mounts the VoicePrefixSteps sub-flow before RuntimeGate.
 *
 * Rendered by StartupShell on first boot when `loadVoicePrefixDone()` is
 * false. When the user completes or explicitly skips the flow, `onDone` is
 * called, which persists the flag and hands control back to StartupShell
 * (which then renders RuntimeGate).
 *
 * Keeps its own step state so the parent doesn't need to know about
 * VoicePrefixStep internals. Defensive: the VoiceProfilesClient falls back
 * gracefully when the server endpoints aren't live (I2 may not have landed).
 */

import * as React from "react";
import { Capacitor } from "@capacitor/core";
import type {
  CatalogModel,
  DownloadJob,
  ModelHubSnapshot,
} from "../../api/client";
import { client } from "../../api/client";
import { ElizaClient } from "../../api/client-base";
import { createVoiceProfilesClient } from "../../api/client-voice-profiles";
import { fetchWithCsrf } from "../../api/csrf-client";
import { getTalkModePlugin } from "../../bridge/native-plugins";
import { useVoiceChat } from "../../hooks/useVoiceChat";
import { IOS_LOCAL_AGENT_IPC_BASE } from "../../onboarding/mobile-runtime-mode";
import type { VoicePrefixStep } from "../../onboarding/voice-prefix";
import { selectRecommendedModelForSlot } from "../../services/local-inference/recommendation";
import { toArrayBuffer } from "../../voice/voice-chat-types";
import {
  VoicePrefixSteps,
  type VoiceBundleReadiness,
} from "./VoicePrefixSteps";
import { Button } from "../ui/button";

export interface VoicePrefixGateProps {
  /** Called when the user completes or skips the voice prefix flow. */
  onDone: () => void;
}

const profilesClient = createVoiceProfilesClient(client);
const voicePrefixLocalInferenceClient = new ElizaClient(
  IOS_LOCAL_AGENT_IPC_BASE,
);
const VOICE_BUNDLE_POLL_MS = 3_000;
let voicePrefixAudioContext: AudioContext | null = null;

const INITIAL_VOICE_BUNDLE_READINESS: VoiceBundleReadiness = {
  modelId: "",
  status: "checking",
  message: "Starting full Bun and checking local voice.",
  percent: null,
  canStartDownload: false,
};

type NativeLocalTtsStatus = {
  ready: boolean;
  status: "assets-ready" | "engine-ready" | "ready" | "missing" | "unavailable";
  message: string;
  modelId?: string;
  bundleDir?: string;
};

type NativeLocalTtsResult = {
  audioBase64?: string;
  contentType: string;
  sampleRate: number;
  samples: number;
  durationMs: number;
  modelId?: string;
  played?: boolean;
};

type NativeLocalTtsDiagnostics = {
  available: boolean;
  selectedBundleDir?: string;
  modelId?: string;
  message?: string;
  probe?: {
    ok: boolean;
    error?: string;
    sampleRate?: number;
    samples?: number;
    durationMs?: number;
  };
  [key: string]: unknown;
};

type LocalVoiceReadinessSnapshot = {
  status?: unknown;
  modelId?: unknown;
  message?: unknown;
};

async function requestNativeMicPermission(): Promise<boolean | null> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") {
    return null;
  }
  try {
    const permissions = await getTalkModePlugin().requestPermissions();
    return permissions.microphone === "granted";
  } catch {
    return null;
  }
}

function getVoiceBundleClient(): ElizaClient {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios") {
    return voicePrefixLocalInferenceClient;
  }
  return client;
}

function percentForDownload(job: DownloadJob): number | null {
  if (job.total <= 0) return null;
  return Math.round((job.received / job.total) * 100);
}

function downloadReadiness(
  model: CatalogModel,
  job: DownloadJob,
): VoiceBundleReadiness {
  const percent = percentForDownload(job);
  if (job.state === "failed") {
    return {
      modelId: model.id,
      status: "failed",
      message:
        job.error ??
        `${model.displayName} did not finish downloading. You can retry now or continue with cloud voice.`,
      percent,
      canStartDownload: true,
    };
  }
  if (job.state === "cancelled") {
    return {
      modelId: model.id,
      status: "available",
      message: `${model.displayName} is available for this phone.`,
      percent: null,
      canStartDownload: true,
    };
  }
  if (job.state === "completed") {
    return {
      modelId: model.id,
      status: "downloading",
      message: `${model.displayName} finished downloading and is finalizing locally.`,
      percent: 100,
      canStartDownload: false,
    };
  }
  return {
    modelId: model.id,
    status: job.state === "queued" ? "queued" : "downloading",
    message: `${model.displayName} is downloading in the background.`,
    percent,
    canStartDownload: false,
  };
}

function voiceBundleReadinessFromHub(
  hub: ModelHubSnapshot,
): VoiceBundleReadiness {
  const voiceReadiness = (
    hub as ModelHubSnapshot & {
      voiceReadiness?: LocalVoiceReadinessSnapshot;
    }
  ).voiceReadiness;
  const model = selectRecommendedModelForSlot(
    "TEXT_SMALL",
    hub.hardware,
    hub.catalog,
  ).model;

  if (
    voiceReadiness?.status === "ready" ||
    voiceReadiness?.status === "engine-ready" ||
    voiceReadiness?.status === "assets-ready"
  ) {
    const modelId =
      typeof voiceReadiness.modelId === "string" && voiceReadiness.modelId
        ? voiceReadiness.modelId
        : (model?.id ?? "");
    return {
      modelId,
      status:
        voiceReadiness.status === "engine-ready"
          ? "engine-ready"
          : "assets-ready",
      message:
        typeof voiceReadiness.message === "string"
          ? voiceReadiness.message
          : voiceReadiness.status === "engine-ready"
            ? "Voice engine is warmed and ready."
            : "Local voice assets are installed. The engine will warm on first playback.",
      percent: 100,
      canStartDownload: false,
    };
  }

  if (!model) {
    return {
      modelId: "",
      status: "checking",
      message:
        "Checking the local voice catalog. You can continue while the phone finishes preparing voice.",
      percent: null,
      canStartDownload: false,
    };
  }

  if (hub.installed.some((installed) => installed.id === model.id)) {
    return {
      modelId: model.id,
      status: "unsupported",
      message:
        typeof voiceReadiness?.message === "string"
          ? voiceReadiness.message
          : `${model.displayName} is installed for local chat. Eliza-1 voice assets are not installed in this build.`,
      percent: null,
      canStartDownload: false,
    };
  }

  const job = hub.downloads.find((download) => download.modelId === model.id);
  if (job) return downloadReadiness(model, job);

  return {
    modelId: model.id,
    status: "available",
    message: `${model.displayName} can run on this phone. Start it now and keep going while it downloads.`,
    percent: null,
    canStartDownload: true,
  };
}

function voiceBundleUnavailableMessage(err: unknown): string {
  const message =
    err instanceof Error
      ? err.message
      : "Local model service is not available.";
  if (
    message.includes("Full Bun iOS runtime") ||
    message.includes("JSContext compatibility transport") ||
    message.includes("cloud builds cannot use local-agent IPC")
  ) {
    return "Full Bun local runtime is still starting. Local models are not ready yet.";
  }
  if (message.includes("no HTTP origin")) {
    return "Local model downloads need a configured local-agent endpoint.";
  }
  return message;
}

function voiceBundleStatusLabel(readiness: VoiceBundleReadiness): string {
  switch (readiness.status) {
    case "ready":
    case "assets-ready":
      return "Local voice ready";
    case "engine-ready":
      return "Voice engine ready";
    case "available":
      return "Local voice available";
    case "queued":
      return "Voice download queued";
    case "downloading":
      return "Downloading local voice";
    case "failed":
      return "Voice download failed";
    case "unsupported":
      return "Local voice issue";
    default:
      return "Checking local voice";
  }
}

function voiceBundleStatusBadge(readiness: VoiceBundleReadiness): string {
  if (typeof readiness.percent === "number") {
    return `${Math.max(0, Math.min(100, readiness.percent))}%`;
  }
  switch (readiness.status) {
    case "unsupported":
      return "engine";
    case "assets-ready":
      return "assets";
    case "engine-ready":
      return "engine";
    case "failed":
      return "retry";
    default:
      return readiness.status;
  }
}

function diagnosticsText(
  diagnostics: NativeLocalTtsDiagnostics | null,
): string {
  if (!diagnostics) return "";
  return JSON.stringify(diagnostics, null, 2).slice(0, 6_000);
}

function nativeIosLocalTtsEnabled(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

async function withNativeIosLocalTtsTimeout<T>(
  label: string,
  operation: Promise<T>,
): Promise<T> {
  let timeoutId: number | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error(`${label} timed out after 15000ms`));
        }, 15_000);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

async function loadNativeIosLocalTtsStatus(): Promise<VoiceBundleReadiness | null> {
  if (!nativeIosLocalTtsEnabled()) return null;
  const { ElizaBunRuntime } = await import("@elizaos/capacitor-bun-runtime");
  if (typeof ElizaBunRuntime.getLocalTtsStatus !== "function") return null;
  const status =
    (await ElizaBunRuntime.getLocalTtsStatus()) as NativeLocalTtsStatus;
  if (
    status.ready &&
    (status.status === "engine-ready" || status.status === "ready")
  ) {
    return {
      modelId: status.modelId ?? "",
      status: "engine-ready",
      message: status.message || "Voice engine is warmed and ready.",
      percent: 100,
      canStartDownload: false,
    };
  }
  if (status.ready && status.status === "assets-ready") {
    return {
      modelId: status.modelId ?? "",
      status: "assets-ready",
      message:
        status.message ||
        "Local voice assets are installed. The engine will warm on first playback.",
      percent: 100,
      canStartDownload: false,
    };
  }
  return {
    modelId: status.modelId ?? "",
    status: "unsupported",
    message: status.message,
    percent: null,
    canStartDownload: false,
  };
}

async function diagnoseNativeIosLocalTts(
  probe: boolean,
): Promise<NativeLocalTtsDiagnostics> {
  const { ElizaBunRuntime } = await import("@elizaos/capacitor-bun-runtime");
  if (typeof ElizaBunRuntime.getLocalTtsDiagnostics !== "function") {
    throw new Error("This build is missing iOS local voice diagnostics.");
  }
  return withNativeIosLocalTtsTimeout(
    probe ? "iOS local voice probe" : "iOS local voice diagnostics",
    ElizaBunRuntime.getLocalTtsDiagnostics({
      probe,
      text: "Hi, I'm Eliza. I'll listen when you talk and reply out loud. Ready?",
    }) as Promise<NativeLocalTtsDiagnostics>,
  );
}

async function synthesizeNativeIosLocalTts(
  text: string,
): Promise<NativeLocalTtsResult> {
  const { ElizaBunRuntime } = await import("@elizaos/capacitor-bun-runtime");
  if (typeof ElizaBunRuntime.synthesizeLocalTts !== "function") {
    throw new Error(
      "This build is missing the iOS local voice playback engine.",
    );
  }
  return ElizaBunRuntime.synthesizeLocalTts({
    text,
    play: true,
    maxSamples: 24_000 * 20,
  });
}

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function playAudioBytes(bytes: Uint8Array): Promise<void> {
  if (typeof AudioContext === "undefined") {
    throw new Error("Local voice playback is not available in this WebView.");
  }

  const context = voicePrefixAudioContext ?? new AudioContext();
  voicePrefixAudioContext = context;
  if (context.state === "suspended") {
    await context.resume();
  }
  if (context.state === "suspended") {
    throw new Error("Local voice playback needs a tap to unlock audio.");
  }

  const audioBuffer = await context.decodeAudioData(toArrayBuffer(bytes));
  await new Promise<void>((resolve) => {
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    source.onended = () => {
      source.disconnect();
      resolve();
    };
    source.start(0);
  });
}

async function playNativeIosVoiceGreeting(text: string): Promise<void> {
  const result = await withNativeIosLocalTtsTimeout(
    "iOS local voice greeting",
    synthesizeNativeIosLocalTts(text),
  );
  if (result.played === true) return;
  if (!result.audioBase64) {
    throw new Error("Native iOS local TTS returned no audio.");
  }
  await playAudioBytes(bytesFromBase64(result.audioBase64));
}

async function playLocalInferenceVoiceGreeting(
  text: string,
  modelId: string,
): Promise<void> {
  const response = await fetchWithCsrf(
    `${IOS_LOCAL_AGENT_IPC_BASE}/api/tts/local-inference`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "audio/wav, audio/*;q=0.9",
      },
      body: JSON.stringify({
        text,
        ...(modelId ? { modelId } : {}),
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Local voice playback failed (${response.status}): ${body.slice(0, 200)}`,
    );
  }

  await playAudioBytes(new Uint8Array(await response.arrayBuffer()));
}

async function loadVoiceBundleReadiness(): Promise<VoiceBundleReadiness> {
  const nativeStatus = await loadNativeIosLocalTtsStatus().catch(() => null);
  if (
    nativeStatus?.status === "ready" ||
    nativeStatus?.status === "engine-ready" ||
    nativeStatus?.status === "assets-ready"
  ) {
    return nativeStatus;
  }
  try {
    const hub = await getVoiceBundleClient().getLocalInferenceHub();
    return voiceBundleReadinessFromHub(hub);
  } catch (err) {
    if (nativeStatus) return nativeStatus;
    return {
      modelId: "",
      status: "unsupported",
      message: voiceBundleUnavailableMessage(err),
      percent: null,
      canStartDownload: false,
    };
  }
}

export function VoicePrefixGate({
  onDone,
}: VoicePrefixGateProps): React.ReactElement {
  const [step, setStep] = React.useState<VoicePrefixStep>("welcome");
  const [voiceBundleReadiness, setVoiceBundleReadiness] =
    React.useState<VoiceBundleReadiness>(INITIAL_VOICE_BUNDLE_READINESS);
  const [localTtsDiagnostics, setLocalTtsDiagnostics] =
    React.useState<NativeLocalTtsDiagnostics | null>(null);
  const [localTtsDiagnosticBusy, setLocalTtsDiagnosticBusy] =
    React.useState(false);
  const autoDiagnosticStartedRef = React.useRef(false);
  const voice = useVoiceChat({
    cloudConnected: false,
    interruptOnSpeech: false,
    lang: "en-US",
    onTranscript: () => {},
    voiceConfig: null,
  });

  const refreshVoiceBundleReadiness = React.useCallback(async () => {
    setVoiceBundleReadiness(await loadVoiceBundleReadiness());
  }, []);

  React.useEffect(() => {
    let alive = true;
    const refresh = async (): Promise<void> => {
      const readiness = await loadVoiceBundleReadiness();
      if (alive) setVoiceBundleReadiness(readiness);
    };
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, VOICE_BUNDLE_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, []);

  const handleAdvance = React.useCallback(
    (next: VoicePrefixStep | null) => {
      if (next === null) {
        // Reached the end of the voice prefix.
        onDone();
        return;
      }
      setStep(next);
    },
    [onDone],
  );

  const handleBack = React.useCallback(() => {
    // On the first step, back is a no-op (there is no previous step).
    // The "Skip all" button handles exiting the flow without completing.
  }, []);

  const handleSkipPrefix = React.useCallback(() => {
    onDone();
  }, [onDone]);

  const handleRequestMicPermission = React.useCallback(async () => {
    const nativeGranted = await requestNativeMicPermission();
    if (nativeGranted !== null) return nativeGranted;

    if (typeof navigator === "undefined" || !navigator.mediaDevices)
      return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Release the stream immediately after permission is granted.
      for (const track of stream.getTracks()) {
        track.stop();
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  const handleNativeTtsDiagnostics = React.useCallback(
    async (probe: boolean) => {
      setLocalTtsDiagnosticBusy(true);
      try {
        const diagnostics = await diagnoseNativeIosLocalTts(probe);
        setLocalTtsDiagnostics(diagnostics);
        if (diagnostics.probe?.ok === true) {
          setVoiceBundleReadiness((current) => ({
            ...current,
            status: "engine-ready",
            message: "Voice engine is warmed and ready.",
            percent: 100,
            canStartDownload: false,
          }));
        }
      } catch (err) {
        setLocalTtsDiagnostics({
          available: false,
          message:
            err instanceof Error
              ? err.message
              : "Failed to run local voice diagnostics.",
        });
      } finally {
        setLocalTtsDiagnosticBusy(false);
      }
    },
    [],
  );

  React.useEffect(() => {
    if (!nativeIosLocalTtsEnabled() || autoDiagnosticStartedRef.current) return;
    autoDiagnosticStartedRef.current = true;
    const timeout = window.setTimeout(() => {
      void handleNativeTtsDiagnostics(false);
    }, 1_200);
    return () => window.clearTimeout(timeout);
  }, [handleNativeTtsDiagnostics]);

  const handleAgentSpeak = React.useCallback(
    async (script: string) => {
      if (nativeIosLocalTtsEnabled()) {
        try {
          await playNativeIosVoiceGreeting(script);
          setVoiceBundleReadiness((current) => ({
            ...current,
            status: "engine-ready",
            message: "Voice engine is warmed and ready.",
            percent: 100,
            canStartDownload: false,
          }));
        } catch (err) {
          void handleNativeTtsDiagnostics(false);
          throw err;
        }
        return;
      }

      if (voiceBundleReadiness.status === "ready") {
        await playLocalInferenceVoiceGreeting(
          script,
          voiceBundleReadiness.modelId,
        );
        return;
      }

      if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios") {
        throw new Error(voiceBundleReadiness.message);
      }

      voice.speak(script);
    },
    [
      handleNativeTtsDiagnostics,
      voice.speak,
      voiceBundleReadiness.message,
      voiceBundleReadiness.modelId,
      voiceBundleReadiness.status,
    ],
  );

  const handleModelDownloadStart = React.useCallback(async () => {
    const modelId = voiceBundleReadiness.modelId;
    if (!modelId) return;

    setVoiceBundleReadiness((current) => ({
      ...current,
      status: "queued",
      message: "Starting the local model download.",
      canStartDownload: false,
    }));

    try {
      const bundleClient = getVoiceBundleClient();
      await bundleClient.startLocalInferenceDownload(modelId);
      await Promise.all([
        bundleClient.setLocalInferenceAssignment("TEXT_SMALL", modelId),
        bundleClient.setLocalInferenceAssignment("TEXT_LARGE", modelId),
        bundleClient.setLocalInferenceAssignment("TEXT_TO_SPEECH", modelId),
        bundleClient.setLocalInferenceAssignment("TRANSCRIPTION", modelId),
      ]);
      await refreshVoiceBundleReadiness();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to start the local voice bundle download.";
      setVoiceBundleReadiness((current) => ({
        ...current,
        status: "failed",
        message,
        canStartDownload: true,
      }));
    }
  }, [refreshVoiceBundleReadiness, voiceBundleReadiness.modelId]);

  return (
    <div
      data-testid="voice-prefix-gate"
      className="relative flex h-full max-h-full min-h-0 w-full items-start justify-center overflow-hidden bg-bg px-3 text-[var(--onboarding-text-primary)]"
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        boxSizing: "border-box",
        height: "100%",
        paddingTop: "max(0.75rem, var(--safe-area-top, 0px))",
        paddingBottom: "max(0.75rem, var(--safe-area-bottom, 0px))",
        background: "transparent",
      }}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          display: "none",
        }}
      />
      <div
        className="relative z-10 flex max-h-full min-h-0 w-full max-w-xl flex-col gap-3 overflow-hidden bg-white/42 p-4 sm:p-5"
        style={{
          borderRadius: "var(--radius-xs, 3px)",
          WebkitBackdropFilter: "blur(18px) saturate(1.1)",
          backdropFilter: "blur(18px) saturate(1.1)",
        }}
      >
        <VoiceBundleStatusStrip
          readiness={voiceBundleReadiness}
          onStartDownload={handleModelDownloadStart}
        />
        {nativeIosLocalTtsEnabled() ? (
          <IosLocalTtsDiagnosticsPanel
            busy={localTtsDiagnosticBusy}
            diagnostics={localTtsDiagnostics}
            onRun={() => void handleNativeTtsDiagnostics(false)}
            onProbe={() => void handleNativeTtsDiagnostics(true)}
            onJumpToGreeting={() => setStep("agent-speaks")}
            onFinish={onDone}
          />
        ) : null}
        <VoicePrefixSteps
          step={step}
          tier={null}
          profilesClient={profilesClient}
          onAdvance={handleAdvance}
          onBack={handleBack}
          onSkipPrefix={handleSkipPrefix}
          onRequestMicPermission={handleRequestMicPermission}
          onAgentSpeak={handleAgentSpeak}
          voiceBundleReadiness={voiceBundleReadiness}
          onModelDownloadStart={handleModelDownloadStart}
        />
      </div>
    </div>
  );
}

function IosLocalTtsDiagnosticsPanel({
  busy,
  diagnostics,
  onRun,
  onProbe,
  onJumpToGreeting,
  onFinish,
}: {
  busy: boolean;
  diagnostics: NativeLocalTtsDiagnostics | null;
  onRun: () => void;
  onProbe: () => void;
  onJumpToGreeting: () => void;
  onFinish: () => void;
}): React.ReactElement {
  const probe = diagnostics?.probe;
  const status =
    probe?.ok === true
      ? "Probe passed"
      : probe?.error
        ? "Probe failed"
        : diagnostics?.available
          ? "Assets found"
          : "Not checked";

  return (
    <details
      className="shrink-0 rounded-sm bg-white/24 px-3 py-2 text-xs text-[var(--onboarding-text-primary)]"
      data-testid="voice-prefix-ios-diagnostics"
    >
      <summary className="cursor-pointer font-semibold">
        iOS local voice diagnostics · {status}
      </summary>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={onRun}
          data-testid="voice-prefix-ios-diagnostics-run"
        >
          Check
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={onProbe}
          data-testid="voice-prefix-ios-diagnostics-probe"
        >
          Probe TTS
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onJumpToGreeting}
          data-testid="voice-prefix-ios-diagnostics-greeting"
        >
          Greeting
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onFinish}
          data-testid="voice-prefix-ios-diagnostics-finish"
        >
          Finish
        </Button>
      </div>
      {diagnostics ? (
        <pre
          className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded-sm bg-white/24 p-2 text-[10px] leading-snug text-[var(--onboarding-text-muted)]"
          data-testid="voice-prefix-ios-diagnostics-output"
        >
          {diagnosticsText(diagnostics)}
        </pre>
      ) : null}
    </details>
  );
}

function VoiceBundleStatusStrip({
  readiness,
  onStartDownload,
}: {
  readiness: VoiceBundleReadiness;
  onStartDownload: () => void | Promise<void>;
}): React.ReactElement {
  const percent =
    typeof readiness.percent === "number"
      ? Math.max(0, Math.min(100, readiness.percent))
      : null;
  const showProgress =
    readiness.status === "queued" ||
    readiness.status === "downloading" ||
    readiness.status === "assets-ready" ||
    readiness.status === "engine-ready" ||
    readiness.status === "ready";
  const progressWidth =
    percent !== null
      ? `${percent}%`
      : readiness.status === "assets-ready" ||
          readiness.status === "engine-ready" ||
          readiness.status === "ready"
        ? "100%"
        : "34%";
  const canStart = readiness.canStartDownload && Boolean(readiness.modelId);

  return (
    <section
      aria-live="polite"
      className="shrink-0 rounded-sm bg-white/30 px-3 py-2 text-[var(--onboarding-text-primary)]"
      data-testid="voice-prefix-persistent-bundle-status"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold">
            {voiceBundleStatusLabel(readiness)}
          </p>
          <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-[var(--onboarding-text-muted)]">
            {readiness.message}
          </p>
        </div>
        {canStart ? (
          <Button
            size="sm"
            variant="secondary"
            className="min-h-10 shrink-0 border-transparent bg-white/38 px-3 text-xs text-[var(--onboarding-text-strong)] hover:bg-white/54"
            onClick={() => void onStartDownload()}
            data-testid="voice-prefix-persistent-start-download"
          >
            Start
          </Button>
        ) : (
          <span className="shrink-0 rounded-sm bg-white/24 px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--onboarding-text-muted)]">
            {voiceBundleStatusBadge(readiness)}
          </span>
        )}
      </div>
      {showProgress ? (
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-sm bg-slate-900/18"
          role="progressbar"
          aria-valuenow={percent ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={percent === null ? readiness.status : undefined}
          data-testid="voice-prefix-persistent-bundle-progress"
        >
          <div
            className="h-full rounded-sm bg-accent transition-[width] duration-500"
            style={{
              width: progressWidth,
              opacity: percent === null ? 0.72 : 1,
            }}
          />
        </div>
      ) : null}
    </section>
  );
}

export default VoicePrefixGate;
