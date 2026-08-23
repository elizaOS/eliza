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
import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { Preferences } from "@capacitor/preferences";
import { StatusBar, Style } from "@capacitor/status-bar";
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import {
  ANDROID_CLOUD_CONVERSATION_ID_KEY,
  type AndroidCloudAccountLifecycleAdapter,
  AndroidCloudApp,
  type AndroidCloudVoiceAdapter,
} from "@elizaos/ui/android-cloud/AndroidCloudApp";
import {
  type AccountDeletionRequestDto,
  parseAccountDeletionAccepted,
  parseAccountDeletionAvailability,
  parseAccountDeletionEnvelope,
  parseAccountDeletionRequest,
} from "@elizaos/ui/android-cloud/account-deletion-contract";
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
  get(options?: { key?: string }): Promise<{ value: string | null }>;
  set(options: { key?: string; value: string }): Promise<void>;
  remove(options?: { key?: string }): Promise<void>;
}

interface PlayExportPlugin {
  saveExport(options: {
    apiBase: string;
    appOrigin: string;
    recoveryCredential: string;
  }): Promise<{ saved: boolean; contentDigest?: string }>;
}

const SecureCredentials = registerPlugin<SecureCredentialsPlugin>(
  "ElizaSecureCredentials",
);
const PlayExport = registerPlugin<PlayExportPlugin>("ElizaPlayExport");

const DELETION_STATUS_CREDENTIAL_KEY = "accountDeletionStatus";
const DELETION_RECOVERY_CREDENTIAL_KEY = "accountDeletionRecovery";
const DELETION_ADMISSION_CREDENTIAL_KEY = "accountDeletionAdmission";
const DELETION_ADMISSION_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function secureCredentialStore(key?: string): AndroidCloudCredentialStore {
  return {
    async read() {
      return (
        (
          await SecureCredentials.get(key ? { key } : undefined)
        ).value?.trim() || null
      );
    },
    async write(token) {
      await SecureCredentials.set({ ...(key ? { key } : {}), value: token });
    },
    async clear() {
      await SecureCredentials.remove(key ? { key } : undefined);
    },
  };
}

const androidSecureCredentialStore = secureCredentialStore();
const deletionStatusCredentialStore = secureCredentialStore(
  DELETION_STATUS_CREDENTIAL_KEY,
);
const deletionRecoveryCredentialStore = secureCredentialStore(
  DELETION_RECOVERY_CREDENTIAL_KEY,
);
const deletionAdmissionCredentialStore = secureCredentialStore(
  DELETION_ADMISSION_CREDENTIAL_KEY,
);
let volatileDeletionStatusCredential: string | null = null;
let volatileDeletionRecoveryCredential: string | null = null;

const androidCloudClient = new AndroidCloudClient({
  credentialStore: androidSecureCredentialStore,
});

class AndroidCloudLifecycleError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AndroidCloudLifecycleError";
  }
}

function responseRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // error-policy:J3 A non-JSON response is translated below.
    }
  }
  return {};
}

async function lifecycleRequest(
  path: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    authenticated?: boolean;
    data?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Origin: androidCloudClient.appBase,
    "x-eliza-csrf": "1",
  };
  if (options.data !== undefined) headers["Content-Type"] = "application/json";
  Object.assign(headers, options.headers);
  if (options.authenticated) {
    const token = await androidCloudClient.readToken();
    if (!token) {
      throw new AndroidCloudLifecycleError(
        "Sign in again before changing account deletion settings.",
        "RECENT_AUTH_REQUIRED",
      );
    }
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await CapacitorHttp.request({
    url: `${androidCloudClient.apiBase}${path}`,
    method: options.method ?? "GET",
    headers,
    data: options.data,
    // Bearer-carrying lifecycle requests must never replay authority across a
    // redirect. A 3xx is a deployment error and stays visible to the caller.
    disableRedirects: true,
  });
  const body = responseRecord(response.data);
  if (response.status < 200 || response.status >= 300) {
    const message =
      (typeof body.error === "string" && body.error) ||
      (typeof body.message === "string" && body.message) ||
      `Account deletion request failed (${response.status}).`;
    const code =
      typeof body.code === "string" && body.code
        ? body.code
        : `HTTP_${response.status}`;
    throw new AndroidCloudLifecycleError(message, code, response.status);
  }
  return { status: response.status, body };
}

async function readPublicLifecycleStatus(): Promise<AccountDeletionRequestDto | null> {
  let statusCredential: string | null;
  try {
    statusCredential =
      (await deletionStatusCredentialStore.read()) ??
      volatileDeletionStatusCredential;
  } catch (error) {
    if (!volatileDeletionStatusCredential) throw error;
    statusCredential = volatileDeletionStatusCredential;
  }
  if (!statusCredential) return null;
  try {
    const response = await lifecycleRequest("/api/public/account-deletion", {
      headers: { "X-Account-Deletion-Status": statusCredential },
    });
    return parseAccountDeletionEnvelope(response.body);
  } catch (error) {
    if (
      error instanceof AndroidCloudLifecycleError &&
      (error.status === 401 || error.status === 404)
    ) {
      await Promise.allSettled([
        deletionStatusCredentialStore.clear(),
        deletionRecoveryCredentialStore.clear(),
      ]);
      volatileDeletionStatusCredential = null;
      volatileDeletionRecoveryCredential = null;
      return null;
    }
    throw error;
  }
}

async function persistDeletionCapabilities(input: {
  statusCredential: string;
  recoveryCredential: string;
}): Promise<void> {
  volatileDeletionStatusCredential = input.statusCredential;
  volatileDeletionRecoveryCredential = input.recoveryCredential;
  try {
    await deletionStatusCredentialStore.write(input.statusCredential);
    await deletionRecoveryCredentialStore.write(input.recoveryCredential);
    const [statusCredential, recoveryCredential] = await Promise.all([
      deletionStatusCredentialStore.read(),
      deletionRecoveryCredentialStore.read(),
    ]);
    if (
      statusCredential !== input.statusCredential ||
      recoveryCredential !== input.recoveryCredential
    ) {
      throw new Error("secure capability read-back failed");
    }
  } catch (cause) {
    await Promise.allSettled([
      deletionStatusCredentialStore.clear(),
      deletionRecoveryCredentialStore.clear(),
    ]);
    throw new AndroidCloudLifecycleError(
      "This device could not preserve account recovery access.",
      "RECOVERY_STORAGE_UNAVAILABLE",
      null,
      { cause },
    );
  }
}

function createDeletionAdmissionCredential(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const credential = globalThis
    .btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  if (!DELETION_ADMISSION_CREDENTIAL_PATTERN.test(credential)) {
    throw new AndroidCloudLifecycleError(
      "This device could not create secure account deletion recovery access.",
      "ADMISSION_CREDENTIAL_INVALID",
    );
  }
  return credential;
}

async function getOrCreateDeletionAdmissionCredential(): Promise<string> {
  try {
    const existing = await deletionAdmissionCredentialStore.read();
    if (existing) {
      if (DELETION_ADMISSION_CREDENTIAL_PATTERN.test(existing)) return existing;
      await deletionAdmissionCredentialStore.clear();
      throw new Error("stored admission credential was malformed");
    }

    const credential = createDeletionAdmissionCredential();
    await deletionAdmissionCredentialStore.write(credential);
    if ((await deletionAdmissionCredentialStore.read()) !== credential) {
      throw new Error("secure admission credential read-back failed");
    }
    return credential;
  } catch (cause) {
    await Promise.allSettled([deletionAdmissionCredentialStore.clear()]);
    throw new AndroidCloudLifecycleError(
      "This device could not preserve account deletion admission access. No deletion request was sent.",
      "ADMISSION_STORAGE_UNAVAILABLE",
      null,
      { cause },
    );
  }
}

async function cancelWithRecoveryCredential(
  recoveryCredential: string,
): Promise<AccountDeletionRequestDto> {
  const response = await lifecycleRequest("/api/public/account-deletion", {
    method: "DELETE",
    headers: { "X-Account-Deletion-Recovery": recoveryCredential },
    data: { confirmation: "CANCEL DELETION" },
  });
  return parseAccountDeletionRequest(response.body.request);
}

export const androidCloudAccountLifecycle: AndroidCloudAccountLifecycleAdapter =
  {
    async getAvailability() {
      const response = await lifecycleRequest("/api/v1/me/account-deletion", {
        authenticated: true,
      });
      return parseAccountDeletionAvailability(response.body);
    },
    async getStatus() {
      const token = await androidCloudClient.readToken();
      if (token) {
        try {
          const response = await lifecycleRequest(
            "/api/v1/me/account-deletion",
            {
              authenticated: true,
            },
          );
          return parseAccountDeletionEnvelope(response.body);
        } catch (error) {
          if (
            !(error instanceof AndroidCloudLifecycleError) ||
            error.status !== 401
          ) {
            throw error;
          }
        }
      }
      return await readPublicLifecycleStatus();
    },
    async requestDeletion() {
      const admissionCredential =
        await getOrCreateDeletionAdmissionCredential();
      let response: Awaited<ReturnType<typeof lifecycleRequest>>;
      try {
        response = await lifecycleRequest("/api/v1/me/account-deletion", {
          method: "POST",
          authenticated: true,
          data: { confirmation: "DELETE", admissionCredential },
        });
      } catch (error) {
        const status =
          error instanceof AndroidCloudLifecycleError ? error.status : null;
        const ambiguousHttpOutcome =
          status === 408 ||
          status === 425 ||
          status === 429 ||
          (status !== null && status >= 500);
        if (
          error instanceof AndroidCloudLifecycleError &&
          !ambiguousHttpOutcome
        ) {
          // A concrete server response means no ambiguous accepted response is
          // being recovered. Never let a rejected/wrong secret become the next
          // admission attempt. Transport, timeout, throttling, and 5xx failures
          // deliberately retain it for an idempotent replay.
          await Promise.allSettled([deletionAdmissionCredentialStore.clear()]);
        }
        throw error;
      }
      const accepted = parseAccountDeletionAccepted(response.body);
      try {
        await persistDeletionCapabilities(accepted);
      } catch (storageError) {
        try {
          const canceling = await cancelWithRecoveryCredential(
            accepted.recoveryCredential,
          );
          volatileDeletionRecoveryCredential = null;
          await Promise.allSettled([deletionAdmissionCredentialStore.clear()]);
          return canceling;
        } catch (rollbackError) {
          throw new AndroidCloudLifecycleError(
            `Deletion receipt ${accepted.request.requestId} was reserved, but this device could not preserve recovery access or verify automatic cancellation. Keep the app open and contact support.`,
            "RECOVERY_STORAGE_AND_ROLLBACK_FAILED",
            null,
            { cause: new AggregateError([storageError, rollbackError]) },
          );
        }
      }
      try {
        await deletionAdmissionCredentialStore.clear();
      } catch (cause) {
        throw new AndroidCloudLifecycleError(
          `Deletion receipt ${accepted.request.requestId} was reserved and recovery access was stored, but this device could not clear its pending admission credential. Retry to finish secure cleanup.`,
          "ADMISSION_CLEANUP_UNAVAILABLE",
          null,
          { cause },
        );
      }
      return accepted.request;
    },
    async cancelDeletion() {
      let recoveryCredential: string | null;
      try {
        recoveryCredential =
          (await deletionRecoveryCredentialStore.read()) ??
          volatileDeletionRecoveryCredential;
      } catch (error) {
        if (!volatileDeletionRecoveryCredential) throw error;
        recoveryCredential = volatileDeletionRecoveryCredential;
      }
      if (!recoveryCredential) {
        throw new AndroidCloudLifecycleError(
          "Recovery access is unavailable on this device.",
          "STATUS_CREDENTIAL_INVALID",
        );
      }
      const request = await cancelWithRecoveryCredential(recoveryCredential);
      if (request.status === "canceling" || request.status === "canceled") {
        volatileDeletionRecoveryCredential = null;
        try {
          await deletionRecoveryCredentialStore.clear();
        } catch (error) {
          // The server invalidates recovery authority when cancellation begins.
          // A stale, now-useless ciphertext must not make Android claim that the
          // server-owned cancellation failed.
          logOptionalPluginFailure("deletion recovery cleanup", error);
        }
      }
      return request;
    },
    async downloadExport() {
      let recoveryCredential: string | null;
      try {
        recoveryCredential =
          (await deletionRecoveryCredentialStore.read()) ??
          volatileDeletionRecoveryCredential;
      } catch (error) {
        if (!volatileDeletionRecoveryCredential) throw error;
        recoveryCredential = volatileDeletionRecoveryCredential;
      }
      if (!recoveryCredential) {
        throw new AndroidCloudLifecycleError(
          "Recovery access is unavailable on this device.",
          "EXPORT_CREDENTIAL_INVALID",
        );
      }
      const result = await PlayExport.saveExport({
        apiBase: androidCloudClient.apiBase,
        appOrigin: androidCloudClient.appBase,
        recoveryCredential,
      });
      return result.saved;
    },
  };

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

interface PlayVoiceListener {
  remove(): Promise<void>;
}

let activeVoiceListeners: PlayVoiceListener[] = [];

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
  ): Promise<PlayVoiceListener>;
  addListener(
    eventName: "error",
    listener: (event: { code: number }) => void,
  ): Promise<PlayVoiceListener>;
}

const PlayVoice = registerPlugin<PlayVoicePlugin>("ElizaPlayVoice");

interface PlaySettingsPlugin {
  openAppSettings(): Promise<void>;
}

const PlaySettings = registerPlugin<PlaySettingsPlugin>("ElizaPlaySettings");

function playVoiceError(code: number): Error {
  const message =
    code === 1
      ? "Voice recognition timed out. Check your connection and try again."
      : code === 2
        ? "Voice recognition lost its network connection. Try again."
        : code === 3
          ? "The microphone audio could not be recorded. Try again."
          : code === 6
            ? "No speech was heard. Try speaking again."
            : code === 7
              ? "No speech was recognized. Try again."
              : code === 8
                ? "Voice recognition is busy. Wait a moment and try again."
                : code === 9
                  ? "Microphone permission is required for voice dictation."
                  : code === 10
                    ? "Voice recognition received too many requests. Wait and try again."
                    : code === 12 || code === 13
                      ? "Voice recognition does not support this language on this device."
                      : "Voice recognition failed. Try again.";
  return new Error(message);
}

function stopVoiceAfterNativeEvent(): void {
  void androidCloudVoice.stop().catch((error) => {
    // error-policy:J6 native-event teardown is best effort after the UI has
    // already consumed the final transcript or recognition failure.
    logOptionalPluginFailure("ElizaPlayVoice teardown", error);
  });
}

export const androidCloudVoice: AndroidCloudVoiceAdapter = {
  async requestAndStart(onFinalTranscript, onError) {
    await androidCloudVoice.stop();
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
        stopVoiceAfterNativeEvent();
      },
    );
    let errorListener: PlayVoiceListener | null = null;
    try {
      errorListener = await PlayVoice.addListener("error", (event) => {
        onError(playVoiceError(event.code));
        stopVoiceAfterNativeEvent();
      });
      activeVoiceListeners = [transcriptListener, errorListener];
      const result = await PlayVoice.startDictation({
        language: navigator.language || "en-US",
      });
      if (!result.started) {
        throw new Error(result.error || "Voice dictation could not start.");
      }
    } catch (error) {
      const listeners = [transcriptListener, errorListener].filter(
        (listener): listener is PlayVoiceListener => listener !== null,
      );
      activeVoiceListeners = [];
      await Promise.allSettled(listeners.map((listener) => listener.remove()));
      throw error;
    }
  },
  async stop() {
    const listeners = activeVoiceListeners;
    activeVoiceListeners = [];
    try {
      await PlayVoice.stopDictation();
    } finally {
      await Promise.allSettled(listeners.map((listener) => listener.remove()));
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
          accountLifecycle={androidCloudAccountLifecycle}
          client={androidCloudClient}
          closeExternal={() => Browser.close()}
          openExternal={openExternal}
          openAppSettings={() => PlaySettings.openAppSettings()}
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
