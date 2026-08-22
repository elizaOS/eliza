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
  secureClear: vi.fn(async (_options?: { key?: string }) => undefined),
  secureGet: vi.fn(async (_options?: { key?: string }) => ({
    value: null as string | null,
  })),
  secureSet: vi.fn(
    async (_options: { key?: string; value: string }) => undefined,
  ),
  httpRequest: vi.fn(),
  saveExport: vi.fn(async () => ({
    saved: true,
    contentDigest: "a".repeat(64),
  })),
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
  CapacitorHttp: { request: playEntry.httpRequest },
  registerPlugin: (name: string) =>
    name === "ElizaSecureCredentials"
      ? {
          get: playEntry.secureGet,
          set: playEntry.secureSet,
          remove: playEntry.secureClear,
        }
      : name === "ElizaPlayExport"
        ? { saveExport: playEntry.saveExport }
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

const STATUS_CAPABILITY = "s".repeat(43);
const RECOVERY_CAPABILITY = "r".repeat(43);

function deletionRequest(status = "reserved") {
  return {
    requestId: "receipt-opaque-1",
    status,
    requestedAt: "2026-08-22T00:00:00.000Z",
    recoveryExpiresAt: "2026-09-21T00:00:00.000Z",
    scheduledDeletionAt: "2026-09-21T00:00:00.000Z",
    irreversibleAt: null,
    completedAt: null,
    identityDeactivated: true,
    canCancel: status === "reserved" || status === "recovery",
    nextAction:
      status === "reserved" ? "wait_for_export" : "download_export_or_cancel",
    export: {
      status: "building",
      readyAt: null,
      expiresAt: "2026-09-21T00:00:00.000Z",
      contentDigest: null,
    },
  };
}

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
  window.localStorage.clear();
  playEntry.preferenceGet.mockResolvedValue({ value: null });
  playEntry.secureGet.mockResolvedValue({ value: null });
  playEntry.secureSet.mockResolvedValue(undefined);
  playEntry.secureClear.mockResolvedValue(undefined);
  playEntry.httpRequest.mockReset();
  playEntry.saveExport.mockResolvedValue({
    saved: true,
    contentDigest: "a".repeat(64),
  });
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

  it("stores both one-time deletion capabilities before accepting reservation", async () => {
    const secure = new Map<string, string>([["session", "steward-token"]]);
    playEntry.secureGet.mockImplementation(async (options) => ({
      value: secure.get(options?.key ?? "session") ?? null,
    }));
    playEntry.secureSet.mockImplementation(async ({ key, value }) => {
      secure.set(key ?? "session", value);
    });
    playEntry.httpRequest.mockResolvedValueOnce({
      status: 202,
      data: {
        request: deletionRequest(),
        statusCredential: STATUS_CAPABILITY,
        recoveryCredential: RECOVERY_CAPABILITY,
      },
    });

    await expect(
      entry.androidCloudAccountLifecycle.requestDeletion(),
    ).resolves.toMatchObject({ status: "reserved" });
    expect(playEntry.httpRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.eliza.app/api/v1/me/account-deletion",
        method: "POST",
        data: { confirmation: "DELETE" },
        disableRedirects: true,
        headers: expect.objectContaining({
          Authorization: "Bearer steward-token",
          Origin: "https://cloud.eliza.app",
        }),
      }),
    );
    expect(secure.get("accountDeletionStatus")).toBe(STATUS_CAPABILITY);
    expect(secure.get("accountDeletionRecovery")).toBe(RECOVERY_CAPABILITY);
  });

  it("uses separate header capabilities for status, undo, and export", async () => {
    const secure = new Map<string, string>([
      ["accountDeletionStatus", STATUS_CAPABILITY],
      ["accountDeletionRecovery", RECOVERY_CAPABILITY],
    ]);
    playEntry.secureGet.mockImplementation(async (options) => ({
      value: secure.get(options?.key ?? "session") ?? null,
    }));
    playEntry.secureClear.mockImplementation(async (options) => {
      secure.delete(options?.key ?? "session");
    });
    playEntry.httpRequest
      .mockResolvedValueOnce({
        status: 200,
        data: { request: deletionRequest("recovery") },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { request: deletionRequest("canceled") },
      });

    await expect(
      entry.androidCloudAccountLifecycle.getStatus(),
    ).resolves.toMatchObject({ status: "recovery" });
    expect(playEntry.httpRequest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://api.eliza.app/api/public/account-deletion",
        headers: expect.objectContaining({
          "X-Account-Deletion-Status": STATUS_CAPABILITY,
        }),
      }),
    );

    await expect(
      entry.androidCloudAccountLifecycle.cancelDeletion(),
    ).resolves.toMatchObject({ status: "canceled" });
    expect(playEntry.httpRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "DELETE",
        data: { confirmation: "CANCEL DELETION" },
        headers: expect.objectContaining({
          "X-Account-Deletion-Recovery": RECOVERY_CAPABILITY,
        }),
      }),
    );

    secure.set("accountDeletionRecovery", RECOVERY_CAPABILITY);
    await entry.androidCloudAccountLifecycle.downloadExport();
    expect(playEntry.saveExport).toHaveBeenCalledWith({
      apiBase: "https://api.eliza.app",
      appOrigin: "https://cloud.eliza.app",
      recoveryCredential: RECOVERY_CAPABILITY,
    });
  });

  it("cancels a reservation if durable recovery storage fails", async () => {
    playEntry.secureGet.mockImplementation(async (options) => ({
      value: options?.key ? null : "steward-token",
    }));
    playEntry.secureSet.mockImplementation(async ({ key }) => {
      if (key === "accountDeletionRecovery") {
        throw new Error("keystore unavailable");
      }
    });
    playEntry.httpRequest
      .mockResolvedValueOnce({
        status: 202,
        data: {
          request: deletionRequest(),
          statusCredential: STATUS_CAPABILITY,
          recoveryCredential: RECOVERY_CAPABILITY,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { request: deletionRequest("canceled") },
      });

    await expect(
      entry.androidCloudAccountLifecycle.requestDeletion(),
    ).rejects.toThrow("Deletion was safely cancelled");
    expect(playEntry.httpRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          "X-Account-Deletion-Recovery": RECOVERY_CAPABILITY,
        }),
      }),
    );
  });
});
