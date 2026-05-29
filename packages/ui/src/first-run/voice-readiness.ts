import { client } from "../api";
import { fetchWithCsrf } from "../api/csrf-client";
import { isAndroid, isDesktopPlatform, isIOS } from "../platform/init";
import { getElizaApiBase, resolveApiUrl } from "../utils";
import { isLocalAsrCaptureSupported } from "../voice/local-asr-capture";
import {
  ANDROID_LOCAL_AGENT_IPC_BASE,
  IOS_LOCAL_AGENT_IPC_BASE,
} from "./mobile-runtime-mode";

const DEFAULT_LOCAL_AGENT_API_BASE = "http://127.0.0.1:31337";

export const FIRST_RUN_VOICE_PREPARING_MESSAGE =
  "Voice input is preparing. You can type while transcription gets ready.";

export type FirstRunVoiceReadiness =
  | { status: "ready"; message: string }
  | { status: "preparing"; message: string }
  | { status: "unsupported"; message: string };

export function resolveFirstRunLocalAgentApiBase(): string {
  if (isIOS) return IOS_LOCAL_AGENT_IPC_BASE;
  if (isAndroid) return ANDROID_LOCAL_AGENT_IPC_BASE;
  return getElizaApiBase() ?? DEFAULT_LOCAL_AGENT_API_BASE;
}

async function hasPackagedLocalAsrRuntime(): Promise<boolean> {
  try {
    const res = await fetchWithCsrf(
      resolveApiUrl("/api/asr/local-inference/status"),
      { method: "GET" },
    );
    if (!res.ok) return false;
    const body = (await res.json()) as { ready?: unknown };
    return body.ready === true;
  } catch {
    return false;
  }
}

export async function prepareFirstRunVoiceAndTranscription(): Promise<FirstRunVoiceReadiness> {
  if (!isLocalAsrCaptureSupported()) {
    if (isDesktopPlatform()) {
      return {
        status: "preparing",
        message: "Preparing desktop microphone capture.",
      };
    }
    return {
      status: "unsupported",
      message: "Voice input is not available in this renderer.",
    };
  }

  try {
    const active = await client.getLocalInferenceActive();
    if (active.status === "ready" && typeof active.modelId === "string") {
      return active.modelId.trim().length > 0
        ? { status: "ready", message: "Voice and transcription ready." }
        : { status: "preparing", message: FIRST_RUN_VOICE_PREPARING_MESSAGE };
    }
    if (await hasPackagedLocalAsrRuntime()) {
      return { status: "ready", message: "Voice and transcription ready." };
    }
    if (active.status === "loading") {
      return {
        status: "preparing",
        message: FIRST_RUN_VOICE_PREPARING_MESSAGE,
      };
    }

    const snapshot = await client.getLocalInferenceHub();
    const installedBundle = snapshot.installed.find(
      (model) => model.source === "eliza-download" && model.bundleRoot,
    );

    if (installedBundle) {
      const nextActive = await client.setLocalInferenceActive(
        installedBundle.id,
      );
      if (
        nextActive.status === "ready" &&
        typeof nextActive.modelId === "string" &&
        nextActive.modelId.trim().length > 0
      ) {
        return { status: "ready", message: "Voice and transcription ready." };
      }
    }

    return {
      status: "preparing",
      message: FIRST_RUN_VOICE_PREPARING_MESSAGE,
    };
  } catch {
    return {
      status: "preparing",
      message: FIRST_RUN_VOICE_PREPARING_MESSAGE,
    };
  }
}
