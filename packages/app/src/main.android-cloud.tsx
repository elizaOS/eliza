/**
 * Dedicated Google Play renderer entry.
 *
 * This file is intentionally independent from the cross-platform `main.tsx`
 * composition root. Keep its static graph limited to the standard Android
 * consumer shell: Eliza Cloud UI, Preferences-backed session persistence, and
 * ordinary Capacitor lifecycle/deep-link/network/keyboard/status-bar APIs.
 */
import { App as CapacitorApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { Preferences } from "@capacitor/preferences";
import { StatusBar, Style } from "@capacitor/status-bar";
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import {
  ANDROID_CLOUD_CONVERSATION_ID_KEY,
  AndroidCloudApp,
  type AndroidCloudVoiceAdapter,
} from "@elizaos/ui/android-cloud/AndroidCloudApp";
import {
  AndroidCloudClient,
  type AndroidCloudCredentialStore,
} from "@elizaos/ui/android-cloud/android-cloud-client";
import { ErrorBoundary } from "@elizaos/ui/components/ui/error-boundary";
import "@elizaos/ui/styles";
import React from "react";
import { createRoot } from "react-dom/client";

export const ANDROID_CLOUD_DEEP_LINK_EVENT =
  "eliza:android-cloud-deep-link" as const;
export const APP_RESUME_EVENT = "eliza:app-resume" as const;
export const APP_PAUSE_EVENT = "eliza:app-pause" as const;
export const NETWORK_STATUS_CHANGE_EVENT =
  "eliza:network-status-change" as const;
export const SHARE_TARGET_EVENT = "eliza:share-target" as const;

interface AndroidCloudShareTarget {
  source: "deep-link";
  title?: string;
  text?: string;
  url?: string;
  files: Array<{ name: string; path: string }>;
}

type AndroidCloudWindow = Window & {
  __ELIZA_APP_SHARE_QUEUE__?: AndroidCloudShareTarget[];
  __ELIZAOS_SHARE_QUEUE__?: AndroidCloudShareTarget[];
  __ELIZA_ANDROID_CLOUD_BRIDGE__?: Readonly<{
    platform: "android";
    native: boolean;
  }>;
};

const CLOUD_PERSISTED_KEYS = Object.freeze([
  "eliza:first-run-complete",
  ANDROID_CLOUD_CONVERSATION_ID_KEY,
]);

interface SecureCredentialsPlugin {
  get(): Promise<{ value: string | null }>;
  set(options: { value: string }): Promise<void>;
  remove(): Promise<void>;
}

const SecureCredentials = registerPlugin<SecureCredentialsPlugin>(
  "ElizaSecureCredentials",
);

const androidSecureCredentialStore: AndroidCloudCredentialStore = {
  async read() {
    return (await SecureCredentials.get()).value?.trim() || null;
  },
  async write(token) {
    await SecureCredentials.set({ value: token });
  },
  async clear() {
    await SecureCredentials.remove();
  },
};

const androidCloudClient = new AndroidCloudClient({
  credentialStore: androidSecureCredentialStore,
});

function logOptionalPluginFailure(plugin: string, error: unknown): void {
  console.warn(
    `[Eliza Android] ${plugin} unavailable:`,
    error instanceof Error ? error.message : error,
  );
}

function dispatchDocumentEvent(name: string, detail?: unknown): void {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Hydrates only the Cloud shell's account/onboarding/chat continuity state. */
export async function hydrateAndroidCloudStorage(): Promise<void> {
  for (const key of CLOUD_PERSISTED_KEYS) {
    try {
      const { value } = await Preferences.get({ key });
      if (value !== null) window.localStorage.setItem(key, value);
    } catch (error) {
      logOptionalPluginFailure("Preferences", error);
    }
  }

  // One-time migration from the previous sandboxed Preferences/localStorage
  // token mirror. The credential is written to Android Keystore-backed storage
  // before both plaintext copies are removed. A secure-store failure aborts
  // boot instead of silently retaining or downgrading the bearer.
  const legacyPreference = await Preferences.get({ key: STEWARD_TOKEN_KEY });
  const legacyToken =
    legacyPreference.value?.trim() ||
    window.localStorage.getItem(STEWARD_TOKEN_KEY)?.trim() ||
    null;
  const secureToken = await androidSecureCredentialStore.read();
  if (!secureToken && legacyToken) {
    await androidSecureCredentialStore.write(legacyToken);
  }
  await Preferences.remove({ key: STEWARD_TOKEN_KEY });
  window.localStorage.removeItem(STEWARD_TOKEN_KEY);
}

/** Mirrors the same minimal allowlist on backgrounding; no runtime endpoints. */
export async function persistAndroidCloudStorage(): Promise<void> {
  await Promise.all(
    CLOUD_PERSISTED_KEYS.map(async (key) => {
      const value = window.localStorage.getItem(key);
      if (value === null) {
        await Preferences.remove({ key });
      } else {
        await Preferences.set({ key, value });
      }
    }),
  );
}

function sharePayloadFromDeepLink(url: URL): AndroidCloudShareTarget {
  const files = url.searchParams
    .getAll("file")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((path) => ({
      name: path.slice(
        Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1,
      ),
      path,
    }));
  return {
    source: "deep-link",
    title: url.searchParams.get("title")?.trim() || undefined,
    text: url.searchParams.get("text")?.trim() || undefined,
    url: url.searchParams.get("url")?.trim() || undefined,
    files,
  };
}

function routePath(url: URL): string {
  return [url.host, url.pathname].join("/").replace(/^\/+|\/+$/g, "");
}

/** Accepts only the app-owned scheme; arbitrary web URLs stay in the browser. */
export function dispatchAndroidCloudDeepLink(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "elizaos:") return false;

  if (routePath(parsed) === "share") {
    const payload = sharePayloadFromDeepLink(parsed);
    const cloudWindow = window as AndroidCloudWindow;
    const queue = cloudWindow.__ELIZA_APP_SHARE_QUEUE__ ?? [];
    queue.push(payload);
    cloudWindow.__ELIZA_APP_SHARE_QUEUE__ = queue;
    cloudWindow.__ELIZAOS_SHARE_QUEUE__ = queue;
    dispatchDocumentEvent(SHARE_TARGET_EVENT, payload);
    const composeText = [payload.title, payload.text, payload.url]
      .filter(Boolean)
      .join("\n");
    if (composeText) {
      window.dispatchEvent(
        new CustomEvent("eliza:android-cloud-compose", {
          detail: { text: composeText },
        }),
      );
    }
  }
  dispatchDocumentEvent(ANDROID_CLOUD_DEEP_LINK_EVENT, { url: rawUrl });
  return true;
}

async function initializeAndroidCloudPlatform(): Promise<void> {
  const cloudWindow = window as AndroidCloudWindow;
  cloudWindow.__ELIZA_ANDROID_CLOUD_BRIDGE__ = Object.freeze({
    platform: "android",
    native: Capacitor.isNativePlatform(),
  });
  dispatchDocumentEvent(
    "eliza:bridge-ready",
    cloudWindow.__ELIZA_ANDROID_CLOUD_BRIDGE__,
  );

  await Promise.allSettled([
    StatusBar.setStyle({ style: Style.Dark }),
    StatusBar.setOverlaysWebView({ overlay: true }),
    StatusBar.setBackgroundColor({ color: "#00000000" }),
  ]);

  void Promise.resolve(
    Keyboard.addListener("keyboardWillShow", ({ keyboardHeight }) => {
      document.body.style.setProperty(
        "--keyboard-height",
        `${keyboardHeight}px`,
      );
      document.body.classList.add("keyboard-open");
    }),
  ).catch((error) => logOptionalPluginFailure("Keyboard", error));
  void Promise.resolve(
    Keyboard.addListener("keyboardWillHide", () => {
      document.body.style.setProperty("--keyboard-height", "0px");
      document.body.classList.remove("keyboard-open");
    }),
  ).catch((error) => logOptionalPluginFailure("Keyboard", error));

  void Promise.resolve(
    CapacitorApp.addListener("appUrlOpen", ({ url }) => {
      dispatchAndroidCloudDeepLink(url);
    }),
  ).catch((error) => logOptionalPluginFailure("App", error));
  void CapacitorApp.getLaunchUrl()
    .then((launch) => {
      if (launch?.url) dispatchAndroidCloudDeepLink(launch.url);
    })
    .catch((error) => logOptionalPluginFailure("App", error));

  void Promise.resolve(
    CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) {
        void persistAndroidCloudStorage().catch((error) =>
          logOptionalPluginFailure("Preferences", error),
        );
      }
      dispatchDocumentEvent(isActive ? APP_RESUME_EVENT : APP_PAUSE_EVENT);
    }),
  ).catch((error) => logOptionalPluginFailure("App", error));
  void Promise.resolve(
    CapacitorApp.addListener("backButton", ({ canGoBack }) => {
      if (canGoBack) window.history.back();
      else
        void CapacitorApp.minimizeApp().catch((error) =>
          logOptionalPluginFailure("App", error),
        );
    }),
  ).catch((error) => logOptionalPluginFailure("App", error));

  void import("@capacitor/network")
    .then(async ({ Network }) => {
      const publish = (connected: boolean) =>
        dispatchDocumentEvent(NETWORK_STATUS_CHANGE_EVENT, { connected });
      publish((await Network.getStatus()).connected);
      await Network.addListener("networkStatusChange", ({ connected }) =>
        publish(connected),
      );
    })
    .catch((error) => logOptionalPluginFailure("Network", error));
}

let activeTranscriptListener: { remove: () => Promise<void> } | null = null;
let activeVoiceErrorListener: { remove: () => Promise<void> } | null = null;

interface PlayVoicePlugin {
  requestPermission(): Promise<{ granted: boolean }>;
  startDictation(options: {
    language: string;
  }): Promise<{ started: boolean; error?: string }>;
  stopDictation(): Promise<void>;
  speak(options: { text: string; language: string }): Promise<void>;
  addListener(
    eventName: "transcript",
    listener: (event: { text: string; isFinal: boolean }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: "error",
    listener: (event: { code?: number; message?: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const PlayVoice = registerPlugin<PlayVoicePlugin>("ElizaPlayVoice");

export const androidCloudVoice: AndroidCloudVoiceAdapter = {
  async requestAndStart(onFinalTranscript, onError) {
    await activeTranscriptListener?.remove();
    await activeVoiceErrorListener?.remove();
    activeTranscriptListener = null;
    activeVoiceErrorListener = null;
    const permissions = await PlayVoice.requestPermission();
    if (!permissions.granted) {
      throw new Error("Microphone permission is required for voice dictation.");
    }
    const transcriptListener = await PlayVoice.addListener(
      "transcript",
      (event) => {
        if (!event.isFinal) return;
        const transcript = event.text.trim();
        if (transcript) onFinalTranscript(transcript);
        void androidCloudVoice.stop();
      },
    );
    activeTranscriptListener = transcriptListener;
    let errorListener: { remove: () => Promise<void> };
    try {
      errorListener = await PlayVoice.addListener("error", (event) => {
        const nativeMessage = event.message?.trim();
        const codeSuffix =
          typeof event.code === "number" ? ` (code ${event.code})` : "";
        onError(
          new Error(
            nativeMessage ||
              `Voice dictation stopped${codeSuffix}. Check your connection and try again.`,
          ),
        );
        void androidCloudVoice.stop();
      });
    } catch (error) {
      await transcriptListener.remove();
      if (activeTranscriptListener === transcriptListener) {
        activeTranscriptListener = null;
      }
      throw error;
    }
    activeVoiceErrorListener = errorListener;
    const result = await PlayVoice.startDictation({
      language: navigator.language || "en-US",
    });
    if (!result.started) {
      await transcriptListener.remove();
      await errorListener.remove();
      if (activeTranscriptListener === transcriptListener) {
        activeTranscriptListener = null;
      }
      if (activeVoiceErrorListener === errorListener) {
        activeVoiceErrorListener = null;
      }
      throw new Error(result.error || "Voice dictation could not start.");
    }
  },
  async stop() {
    const listener = activeTranscriptListener;
    const errorListener = activeVoiceErrorListener;
    activeTranscriptListener = null;
    activeVoiceErrorListener = null;
    try {
      await PlayVoice.stopDictation();
    } finally {
      await Promise.all([listener?.remove(), errorListener?.remove()]);
    }
  },
  async speak(text) {
    await PlayVoice.speak({ text, language: navigator.language || "en-US" });
  },
};

async function openExternal(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("Eliza sign-in must use HTTPS.");
  }
  await Browser.open({ url: parsed.toString() });
}

function renderBootFailure(error: unknown): void {
  const root = document.getElementById("root");
  if (!root) return;
  root.textContent =
    "Eliza could not start. Close and reopen the app to retry.";
  root.setAttribute("role", "alert");
  console.error("[Eliza Android] boot failed", error);
}

export async function bootAndroidCloudApp(): Promise<void> {
  await hydrateAndroidCloudStorage();
  await initializeAndroidCloudPlatform();
  const root = document.getElementById("root");
  if (!root) throw new Error("Android Cloud renderer root is missing");
  createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <AndroidCloudApp
          client={androidCloudClient}
          closeExternal={() => Browser.close()}
          openExternal={openExternal}
          voice={androidCloudVoice}
        />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

function boot(): void {
  void bootAndroidCloudApp().catch(renderBootFailure);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
