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
  browserClose: vi.fn(async () => undefined),
  browserOpen: vi.fn(async (_options: { url: string }) => undefined),
  deepLinkAcknowledge: vi.fn(async (_options: { url: string }) => ({
    cleared: true,
  })),
  deepLinkPeek: vi.fn(async () => ({ value: null as string | null })),
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

vi.mock("@capacitor/browser", () => ({
  Browser: {
    addListener: vi.fn(async (name: string, listener: () => void) => {
      void name;
      void listener;
      return { remove: vi.fn() };
    }),
    close: playEntry.browserClose,
    open: playEntry.browserOpen,
  },
}));

vi.mock("react-dom/client", () => ({ createRoot: playEntry.createRoot }));
vi.mock("@elizaos/ui/android-cloud/AndroidCloudApp", () => ({
  ANDROID_CLOUD_CONVERSATION_ID_KEY: "eliza:android-cloud-conversation-id",
  ANDROID_CLOUD_DEEP_LINK_EVENT: "eliza:android-cloud-deep-link",
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
      : name === "DeepLinkBuffer"
        ? {
            acknowledgePendingUrl: playEntry.deepLinkAcknowledge,
            peekPendingUrl: async () => ({
              url: (await playEntry.deepLinkPeek()).value,
            }),
          }
        : {
            addListener: vi.fn(async () => ({ remove: vi.fn() })),
            requestPermission: vi.fn(async () => ({ granted: true })),
            speak: vi.fn(async () => undefined),
            startDictation: vi.fn(async () => ({ started: true })),
            stopDictation: vi.fn(async () => undefined),
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
  window.localStorage.clear();
  playEntry.preferenceGet.mockResolvedValue({ value: null });
  playEntry.secureGet.mockResolvedValue({ value: null });
  playEntry.secureSet.mockResolvedValue(undefined);
  playEntry.deepLinkPeek.mockResolvedValue({ value: null });
  playEntry.deepLinkAcknowledge.mockResolvedValue({ cleared: true });
});

describe("Android Cloud renderer behavior", () => {
  it("opens hosted sign-in only in an HTTPS Custom Tab without cancelling the pending callback", async () => {
    await expect(
      entry.openAndroidCloudSignIn("http://example.com/auth"),
    ).rejects.toThrow("must use HTTPS");

    const opening = entry.openAndroidCloudSignIn(
      "https://cloud-staging.eliza.app/login?returnTo=%2Fapp-auth%2Fauthorize%3Fflow%3Dmobile_pkce",
    );
    await vi.waitFor(() =>
      expect(playEntry.browserOpen).toHaveBeenCalledOnce(),
    );
    expect(playEntry.browserOpen).toHaveBeenCalledWith({
      url: "https://cloud-staging.eliza.app/login?returnTo=%2Fapp-auth%2Fauthorize%3Fflow%3Dmobile_pkce",
    });
    await expect(opening).resolves.toBe("opened");
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

  it("replays and acknowledges the native auth callback after the shell mounts", async () => {
    const callback = "elizaos://auth/callback?code=code-1&state=state-1";
    playEntry.deepLinkPeek.mockResolvedValue({ value: callback });
    const delivery = vi.fn((event: Event) => {
      const detail = (
        event as CustomEvent<{
          acknowledge?: () => Promise<void>;
          url?: string;
        }>
      ).detail;
      expect(detail.url).toBe(callback);
      void detail.acknowledge?.();
    });
    document.addEventListener("eliza:android-cloud-deep-link", delivery);

    playEntry.appListeners.get("appStateChange")?.({ isActive: true });

    await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(playEntry.deepLinkAcknowledge).toHaveBeenCalledWith({
        url: callback,
      }),
    );

    playEntry.appListeners.get("appUrlOpen")?.({ url: callback });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(delivery).toHaveBeenCalledOnce();
    document.removeEventListener("eliza:android-cloud-deep-link", delivery);
  });
});
