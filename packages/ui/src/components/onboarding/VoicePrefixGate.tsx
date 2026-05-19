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
import { getTalkModePlugin } from "../../bridge/native-plugins";
import { useVoiceChat } from "../../hooks/useVoiceChat";
import { IOS_LOCAL_AGENT_IPC_BASE } from "../../onboarding/mobile-runtime-mode";
import type { VoicePrefixStep } from "../../onboarding/voice-prefix";
import { selectRecommendedModelForSlot } from "../../services/local-inference/recommendation";
import {
  VoicePrefixSteps,
  type VoiceBundleReadiness,
} from "./VoicePrefixSteps";

export interface VoicePrefixGateProps {
  /** Called when the user completes or skips the voice prefix flow. */
  onDone: () => void;
}

const profilesClient = createVoiceProfilesClient(client);
const voicePrefixLocalInferenceClient = new ElizaClient(
  IOS_LOCAL_AGENT_IPC_BASE,
);
const VOICE_BUNDLE_POLL_MS = 3_000;

const INITIAL_VOICE_BUNDLE_READINESS: VoiceBundleReadiness = {
  modelId: "",
  status: "checking",
  message: "Checking what this phone can run.",
  percent: null,
  canStartDownload: false,
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
  const model = selectRecommendedModelForSlot(
    "TEXT_SMALL",
    hub.hardware,
    hub.catalog,
  ).model;

  if (!model) {
    return {
      modelId: "",
      status: "unsupported",
      message:
        "This phone does not currently have a fitting local voice bundle. You can continue with cloud voice.",
      percent: null,
      canStartDownload: false,
    };
  }

  if (hub.installed.some((installed) => installed.id === model.id)) {
    return {
      modelId: model.id,
      status: "ready",
      message: `${model.displayName} is installed and ready for local voice.`,
      percent: 100,
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
    return "The local voice service is still starting. Keep the app open and try again in a moment.";
  }
  if (message.includes("no HTTP origin")) {
    return "Local voice downloads need a configured local-agent endpoint.";
  }
  return message;
}

async function loadVoiceBundleReadiness(): Promise<VoiceBundleReadiness> {
  try {
    const hub = await getVoiceBundleClient().getLocalInferenceHub();
    return voiceBundleReadinessFromHub(hub);
  } catch (err) {
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
  }, [refreshVoiceBundleReadiness]);

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

  const handleAgentSpeak = React.useCallback(
    async (script: string) => {
      if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios") {
        const result = await getTalkModePlugin().speak({
          text: script,
          directive: { language: "en-US", once: true },
          useLocalInferenceTts: false,
          useSystemTts: true,
        });
        if (!result.completed && !result.interrupted) {
          throw new Error(result.error ?? "Native voice playback failed.");
        }
        return;
      }

      voice.speak(script);
    },
    [voice.speak],
  );

  const handleModelDownloadStart = React.useCallback(async () => {
    const modelId = voiceBundleReadiness.modelId;
    if (!modelId) return;

    setVoiceBundleReadiness((current) => ({
      ...current,
      status: "queued",
      message: "Starting the local voice bundle download.",
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
      className="flex h-full max-h-full min-h-0 w-full items-start justify-center overflow-hidden bg-[#0a0805] px-3 text-white"
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        boxSizing: "border-box",
        height: "100%",
        paddingTop: "0.75rem",
        paddingBottom: "0.75rem",
      }}
    >
      <div
        className="flex max-h-full min-h-0 w-full max-w-xl flex-col overflow-hidden border-2 border-black bg-[#111318]/95 p-4 shadow-[7px_7px_0_rgba(0,0,0,0.62)] sm:p-6"
        style={{
          borderRadius: 0,
          clipPath:
            "polygon(14px 0,100% 0,100% calc(100% - 14px),calc(100% - 14px) 100%,0 100%,0 14px)",
          boxShadow:
            "0 1px 0 rgba(255,255,255,0.08) inset, 0 -16px 28px rgba(0,0,0,0.34) inset, 7px 7px 0 rgba(0,0,0,0.62)",
        }}
      >
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

export default VoicePrefixGate;
