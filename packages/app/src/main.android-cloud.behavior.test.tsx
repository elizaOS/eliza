/**
 * Executes the Play renderer's native storage and deep-link boundaries with
 * deterministic Capacitor adapters; no source-text assertions stand in for
 * credential migration, persistence, or event delivery.
 */
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { ANDROID_CLOUD_CONVERSATION_ID_KEY } from "@elizaos/ui/android-cloud/AndroidCloudApp";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const playEntry = vi.hoisted(() => ({
  appListeners: new Map<string, (value: unknown) => void>(),
  voiceListeners: new Map<string, (value: never) => void>(),
  voiceListenerRemovals: new Map<string, ReturnType<typeof vi.fn>>(),
  voiceListenerGate: null as Promise<void> | null,
  voiceStart: vi.fn(async () => ({ started: true })),
  voiceStop: vi.fn(async () => undefined),
  createRoot: vi.fn(() => ({ render: vi.fn() })),
  preferenceGet: vi.fn(async (_options: { key: string }) => ({
    value: null as string | null,
  })),
  preferenceRemove: vi.fn(async (_options: { key: string }) => undefined),
  preferenceSet: vi.fn(
    async (_options: { key: string; value: string }) => undefined,
  ),
  secureClear: vi.fn(async () => undefined),
  secureGet: vi.fn(async () => ({ value: null as string | null })),
  secureSet: vi.fn(async (_options: { value: string }) => undefined),
}));

vi.mock("react-dom/client", () => ({ createRoot: playEntry.createRoot }));
vi.mock("@elizaos/ui/android-cloud/AndroidCloudApp", () => ({
  ANDROID_CLOUD_CONVERSATION_ID_KEY: "eliza:android-cloud-conversation-id",
  AndroidCloudApp: () => null,
}));
vi.mock("@elizaos/ui/components/ui/error-boundary", () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@elizaos/ui/styles", () => ({}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: (name: string) =>
    name === "ElizaSecureCredentials"
      ? {
          get: playEntry.secureGet,
          set: playEntry.secureSet,
          remove: playEntry.secureClear,
        }
      : {
          addListener: vi.fn(
            async (eventName: string, listener: (value: never) => void) => {
              await playEntry.voiceListenerGate;
              playEntry.voiceListeners.set(eventName, listener);
              const remove = vi.fn(async () => {
                if (playEntry.voiceListeners.get(eventName) === listener) {
                  playEntry.voiceListeners.delete(eventName);
                }
              });
              playEntry.voiceListenerRemovals.set(eventName, remove);
              return { remove };
            },
          ),
          requestPermission: vi.fn(async () => ({ granted: true })),
          speak: vi.fn(async () => undefined),
          startDictation: playEntry.voiceStart,
          stopDictation: playEntry.voiceStop,
        },
}));
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: playEntry.preferenceGet,
    remove: playEntry.preferenceRemove,
    set: playEntry.preferenceSet,
  },
}));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(
      async (name: string, listener: (value: unknown) => void) => {
        playEntry.appListeners.set(name, listener);
        return { remove: vi.fn() };
      },
    ),
    getLaunchUrl: vi.fn(async () => undefined),
    minimizeApp: vi.fn(async () => undefined),
  },
}));
vi.mock("@capacitor/browser", () => ({
  Browser: {
    close: vi.fn(async () => undefined),
    open: vi.fn(async () => undefined),
  },
}));
vi.mock("@capacitor/keyboard", () => ({
  Keyboard: { addListener: vi.fn(async () => ({ remove: vi.fn() })) },
}));
vi.mock("@capacitor/network", () => ({
  Network: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
    getStatus: vi.fn(async () => ({ connected: true })),
  },
}));
vi.mock("@capacitor/status-bar", () => ({
  Style: { Dark: "dark" },
  StatusBar: {
    setBackgroundColor: vi.fn(async () => undefined),
    setOverlaysWebView: vi.fn(async () => undefined),
    setStyle: vi.fn(async () => undefined),
  },
}));

let entry: typeof import("./main.android-cloud");

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>';
  entry = await import("./main.android-cloud");
  if (document.readyState === "loading") {
    document.dispatchEvent(new Event("DOMContentLoaded"));
  }
  await vi.waitFor(() => expect(playEntry.createRoot).toHaveBeenCalledOnce());
});

beforeEach(async () => {
  await entry.androidCloudVoice.stop();
  vi.clearAllMocks();
  playEntry.appListeners.clear();
  playEntry.voiceListeners.clear();
  playEntry.voiceListenerRemovals.clear();
  playEntry.voiceListenerGate = null;
  playEntry.voiceStart.mockResolvedValue({ started: true });
  playEntry.voiceStop.mockResolvedValue(undefined);
  window.localStorage.clear();
  playEntry.preferenceGet.mockResolvedValue({ value: null });
  playEntry.secureGet.mockResolvedValue({ value: null });
  playEntry.secureSet.mockResolvedValue(undefined);
});

describe("Android Cloud renderer behavior", () => {
  it("surfaces native voice errors and removes both terminal listeners", async () => {
    const onTranscript = vi.fn();
    const onError = vi.fn();

    await entry.androidCloudVoice.requestAndStart(onTranscript, onError);
    expect([...playEntry.voiceListeners.keys()].sort()).toEqual([
      "error",
      "transcript",
    ]);

    playEntry.voiceListeners.get("error")?.({ code: 7 } as never);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "No speech was recognized. Try again.",
      }),
    );
    await vi.waitFor(() => expect(playEntry.voiceListeners.size).toBe(0));
    expect(
      playEntry.voiceListenerRemovals.get("transcript"),
    ).toHaveBeenCalledOnce();
    expect(playEntry.voiceListenerRemovals.get("error")).toHaveBeenCalledOnce();
  });

  it("removes both native listeners when dictation fails to start", async () => {
    playEntry.voiceStart.mockRejectedValueOnce(new Error("recognizer failed"));

    await expect(
      entry.androidCloudVoice.requestAndStart(vi.fn(), vi.fn()),
    ).rejects.toThrow("Voice dictation could not start.");

    expect(playEntry.voiceListeners.size).toBe(0);
    expect(
      playEntry.voiceListenerRemovals.get("transcript"),
    ).toHaveBeenCalledOnce();
    expect(playEntry.voiceListenerRemovals.get("error")).toHaveBeenCalledOnce();
  });

  it("cancels startup and removes listeners when stopped during registration", async () => {
    const listenerGate = deferred<void>();
    playEntry.voiceListenerGate = listenerGate.promise;

    const startup = entry.androidCloudVoice.requestAndStart(vi.fn(), vi.fn());
    await vi.waitFor(() => expect(playEntry.voiceStop).toHaveBeenCalledOnce());
    const stopped = entry.androidCloudVoice.stop();
    listenerGate.resolve(undefined);

    await expect(startup).rejects.toMatchObject({ name: "AbortError" });
    await expect(stopped).resolves.toBeUndefined();
    expect(playEntry.voiceStart).not.toHaveBeenCalled();
    expect(playEntry.voiceListeners.size).toBe(0);
  });

  it("serializes overlapping starts without leaking the first listener pair", async () => {
    const firstNativeStart = deferred<{ started: boolean }>();
    playEntry.voiceStart
      .mockReturnValueOnce(firstNativeStart.promise)
      .mockResolvedValueOnce({ started: true });

    const first = entry.androidCloudVoice.requestAndStart(vi.fn(), vi.fn());
    await vi.waitFor(() => expect(playEntry.voiceStart).toHaveBeenCalledOnce());
    const firstRemovals = [
      playEntry.voiceListenerRemovals.get("transcript"),
      playEntry.voiceListenerRemovals.get("error"),
    ];
    const second = entry.androidCloudVoice.requestAndStart(vi.fn(), vi.fn());
    firstNativeStart.resolve({ started: true });

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toBeUndefined();
    expect(playEntry.voiceStart).toHaveBeenCalledTimes(2);
    expect(firstRemovals[0]).toHaveBeenCalledOnce();
    expect(firstRemovals[1]).toHaveBeenCalledOnce();
    expect([...playEntry.voiceListeners.keys()].sort()).toEqual([
      "error",
      "transcript",
    ]);

    await entry.androidCloudVoice.stop();
    expect(playEntry.voiceListeners.size).toBe(0);
  });

  it("migrates a legacy bearer into the secure plugin before deleting plaintext", async () => {
    const order: string[] = [];
    playEntry.preferenceGet.mockImplementation(async ({ key }) => ({
      value: key === STEWARD_TOKEN_KEY ? " legacy-token " : null,
    }));
    playEntry.secureSet.mockImplementation(async ({ value }) => {
      expect(value).toBe("legacy-token");
      order.push("secure-write");
    });
    playEntry.preferenceRemove.mockImplementation(async ({ key }) => {
      if (key === STEWARD_TOKEN_KEY) order.push("plaintext-remove");
    });

    await entry.hydrateAndroidCloudStorage();

    expect(order).toEqual(["secure-write", "plaintext-remove"]);
    expect(window.localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("fails closed without deleting a bearer when secure migration fails", async () => {
    playEntry.preferenceGet.mockImplementation(async ({ key }) => ({
      value: key === STEWARD_TOKEN_KEY ? "legacy-token" : null,
    }));
    playEntry.secureSet.mockRejectedValueOnce(
      new Error("keystore unavailable"),
    );

    await expect(entry.hydrateAndroidCloudStorage()).rejects.toThrow(
      "keystore unavailable",
    );
    expect(playEntry.preferenceRemove).not.toHaveBeenCalledWith({
      key: STEWARD_TOKEN_KEY,
    });
  });

  it("persists only the Cloud shell allowlist and never mirrors its bearer", async () => {
    window.localStorage.setItem("eliza:first-run-complete", "true");
    window.localStorage.setItem(
      ANDROID_CLOUD_CONVERSATION_ID_KEY,
      "conversation-1",
    );
    window.localStorage.setItem(STEWARD_TOKEN_KEY, "must-not-persist");

    await entry.persistAndroidCloudStorage();

    expect(playEntry.preferenceSet).toHaveBeenCalledTimes(2);
    expect(playEntry.preferenceSet).toHaveBeenCalledWith({
      key: "eliza:first-run-complete",
      value: "true",
    });
    expect(playEntry.preferenceSet).toHaveBeenCalledWith({
      key: ANDROID_CLOUD_CONVERSATION_ID_KEY,
      value: "conversation-1",
    });
    expect(playEntry.preferenceSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: STEWARD_TOKEN_KEY }),
    );
  });

  it("accepts only app-owned deep links and dispatches a share payload", () => {
    const compose = vi.fn();
    const share = vi.fn();
    window.addEventListener("eliza:android-cloud-compose", compose);
    document.addEventListener("eliza:share-target", share);

    expect(
      entry.dispatchAndroidCloudDeepLink("https://example.com/share"),
    ).toBe(false);
    expect(
      entry.dispatchAndroidCloudDeepLink(
        "elizaos://share?title=Hello&text=world&file=%2Ftmp%2Fproof.jpg",
      ),
    ).toBe(true);
    expect(share).toHaveBeenCalledOnce();
    expect(compose).toHaveBeenCalledOnce();
    expect(
      (window as Window & { __ELIZA_APP_SHARE_QUEUE__?: unknown[] })
        .__ELIZA_APP_SHARE_QUEUE__,
    ).toEqual([
      expect.objectContaining({
        files: [{ name: "proof.jpg", path: "/tmp/proof.jpg" }],
        source: "deep-link",
        text: "world",
        title: "Hello",
      }),
    ]);

    window.removeEventListener("eliza:android-cloud-compose", compose);
    document.removeEventListener("eliza:share-target", share);
  });
});
