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
  voiceListeners: new Map<string, (value: unknown) => void>(),
  voiceListenerRemovers: [] as Array<ReturnType<typeof vi.fn>>,
  voiceListenerSetupFailure: null as "transcript" | "error" | null,
  voicePermission: vi.fn(async () => ({ granted: true })),
  voiceStart: vi.fn(async () => ({ started: true })),
  voiceStop: vi.fn(async () => undefined),
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
            async (name: string, listener: (value: unknown) => void) => {
              if (playEntry.voiceListenerSetupFailure === name) {
                throw new Error(`${name} listener setup failed`);
              }
              playEntry.voiceListeners.set(name, listener);
              const remove = vi.fn(async () => {
                playEntry.voiceListeners.delete(name);
              });
              playEntry.voiceListenerRemovers.push(remove);
              return { remove };
            },
          ),
          requestPermission: playEntry.voicePermission,
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

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>';
  entry = await import("./main.android-cloud");
  if (document.readyState === "loading") {
    document.dispatchEvent(new Event("DOMContentLoaded"));
  }
  await vi.waitFor(() => expect(playEntry.createRoot).toHaveBeenCalledOnce());
});

beforeEach(() => {
  vi.clearAllMocks();
  playEntry.appListeners.clear();
  playEntry.voiceListeners.clear();
  playEntry.voiceListenerRemovers.length = 0;
  playEntry.voiceListenerSetupFailure = null;
  window.localStorage.clear();
  playEntry.preferenceGet.mockResolvedValue({ value: null });
  playEntry.secureGet.mockResolvedValue({ value: null });
  playEntry.secureSet.mockResolvedValue(undefined);
  playEntry.voicePermission.mockResolvedValue({ granted: true });
  playEntry.voiceStart.mockResolvedValue({ started: true });
  playEntry.voiceStop.mockResolvedValue(undefined);
});

describe("Android Cloud renderer behavior", () => {
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

  it("routes native recognition errors through the voice adapter", async () => {
    const onError = vi.fn();
    await entry.androidCloudVoice.requestAndStart(vi.fn(), onError);

    playEntry.voiceListeners.get("error")?.({ code: 7 });

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      message: "Voice dictation stopped unexpectedly (code 7).",
    });
  });

  it("does not start native recognition after a delayed start is canceled", async () => {
    let finishPermission: (value: { granted: boolean }) => void = () => {};
    playEntry.voicePermission.mockReturnValueOnce(
      new Promise((resolve) => {
        finishPermission = resolve;
      }),
    );

    const starting = entry.androidCloudVoice.requestAndStart(vi.fn(), vi.fn());
    await vi.waitFor(() =>
      expect(playEntry.voicePermission).toHaveBeenCalled(),
    );
    await entry.androidCloudVoice.stop();
    finishPermission({ granted: true });

    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(playEntry.voiceStart).not.toHaveBeenCalled();
  });

  it("observes native-event voice teardown failures", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await entry.androidCloudVoice.requestAndStart(vi.fn(), vi.fn());
    playEntry.voiceStop.mockRejectedValueOnce(new Error("native stop failed"));

    playEntry.voiceListeners.get("error")?.({ code: 7 });

    await vi.waitFor(() =>
      expect(warning).toHaveBeenCalledWith(
        "[Eliza Android] ElizaPlayVoice teardown unavailable:",
        "native stop failed",
      ),
    );
    warning.mockRestore();
  });

  it("stops native recognition even when listener teardown fails", async () => {
    await entry.androidCloudVoice.requestAndStart(vi.fn(), vi.fn());
    playEntry.voiceStop.mockClear();
    playEntry.voiceListenerRemovers[0]?.mockRejectedValueOnce(
      new Error("listener teardown failed"),
    );

    await expect(entry.androidCloudVoice.stop()).rejects.toThrow(
      "listener teardown failed",
    );
    expect(playEntry.voiceStop).toHaveBeenCalledOnce();
  });

  it("stops native recognition before a pending listener remover times out", async () => {
    vi.useFakeTimers();
    try {
      await entry.androidCloudVoice.requestAndStart(vi.fn(), vi.fn());
      playEntry.voiceStop.mockClear();
      playEntry.voiceListenerRemovers[0]?.mockImplementationOnce(
        () => new Promise<void>(() => {}),
      );

      const stopping = entry.androidCloudVoice.stop();
      const rejection = expect(stopping).rejects.toThrow("teardown timed out");
      expect(playEntry.voiceStop).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;

      await expect(entry.androidCloudVoice.stop()).resolves.toBeUndefined();
      expect(playEntry.voiceListenerRemovers[0]).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports every listener and native teardown failure", async () => {
    await entry.androidCloudVoice.requestAndStart(vi.fn(), vi.fn());
    playEntry.voiceStop.mockClear();
    const transcriptFailure = new Error("transcript teardown failed");
    const errorFailure = new Error("error teardown failed");
    const nativeFailure = new Error("native stop failed");
    playEntry.voiceListenerRemovers[0]?.mockRejectedValueOnce(
      transcriptFailure,
    );
    playEntry.voiceListenerRemovers[1]?.mockRejectedValueOnce(errorFailure);
    playEntry.voiceStop.mockRejectedValueOnce(nativeFailure);

    let failure: unknown;
    try {
      await entry.androidCloudVoice.stop();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      transcriptFailure,
      errorFailure,
      nativeFailure,
    ]);
    expect(playEntry.voiceStop).toHaveBeenCalledOnce();
  });

  it("cleans up a transcript listener when error-listener setup fails", async () => {
    playEntry.voiceListenerSetupFailure = "error";

    await expect(
      entry.androidCloudVoice.requestAndStart(vi.fn(), vi.fn()),
    ).rejects.toThrow("error listener setup failed");

    expect(playEntry.voiceListenerRemovers).toHaveLength(1);
    expect(playEntry.voiceListenerRemovers[0]).toHaveBeenCalledOnce();
    expect(playEntry.voiceStop).toHaveBeenCalledTimes(2);
    expect(playEntry.voiceListeners.size).toBe(0);
  });
});
