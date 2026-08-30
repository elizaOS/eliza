// @vitest-environment jsdom

/** Verifies native hosted-login cancellation releases the canonical shell lock. */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  begin: vi.fn(async () => ({
    state: "attempt-1",
    browserUrl: "https://cloud.eliza.app/login",
  })),
  browserFinished: null as null | (() => void),
  cancel: vi.fn(async () => true),
  directCloudRequest: vi.fn(),
  sequence: 0,
  stewardToken: null as string | null,
  switchAccountPending: false,
  api: {
    getBaseUrl: vi.fn(() => ""),
    setBaseUrl: vi.fn(),
    setToken: vi.fn(),
    getCloudStatus: vi.fn(async () => ({
      connected: true,
      enabled: true,
      userId: "owned-user",
    })),
    getCloudCredits: vi.fn(async () => ({ balance: 0 })),
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "android",
    isNativePlatform: () => true,
  },
  CapacitorHttp: {
    request: harness.directCloudRequest,
  },
}));

vi.mock("@elizaos/shared/steward-session-client", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@elizaos/shared/steward-session-client")
    >();
  return {
    ...original,
    clearStoredStewardToken: vi.fn(async () => {}),
    readStoredStewardToken: vi.fn(() => harness.stewardToken),
    replaceStoredStewardTokenIfCurrent: vi.fn(async () => false),
    writeStoredStewardToken: vi.fn(async () => {}),
  };
});

vi.mock("../platform/android-runtime", () => ({
  isAndroidCloudBuild: () => true,
  isAndroidLauncherBuild: () => false,
}));

vi.mock("../api", () => ({ client: harness.api }));

vi.mock("../android-cloud/android-cloud-auth", () => ({
  ANDROID_CLOUD_AUTH_RESULT_EVENT: "eliza:android-cloud-auth-result",
  ANDROID_CLOUD_AUTH_STARTED_EVENT: "eliza:android-cloud-auth-started",
  beginAndroidCloudSignIn: harness.begin,
  cancelAndroidCloudSignIn: harness.cancel,
  clearAndroidCloudAccountSwitchPending: vi.fn(() => {
    harness.switchAccountPending = false;
  }),
  isAndroidCloudAccountSwitchPending: vi.fn(() => harness.switchAccountPending),
  markAndroidCloudAccountSwitchPending: vi.fn(() => {
    harness.switchAccountPending = true;
  }),
  signOutAndroidCloud: vi.fn(async () => {}),
  hasPendingAndroidCloudSignIn: vi.fn(async () => {
    throw new Error("pending cleanup record unavailable");
  }),
  takeLatestAndroidCloudCompletion: vi.fn(() => null),
}));

vi.mock("../utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("../utils")>();
  return {
    ...original,
    closeExternalBrowser: vi.fn(async () => {}),
    listenForExternalBrowserFinished: vi.fn(async (listener: () => void) => {
      harness.browserFinished = listener;
      return async () => {
        harness.browserFinished = null;
      };
    }),
    openExternalUrl: vi.fn(async () => true),
  };
});

import { useCloudState } from "./useCloudState";

const runtimeWithPinnedRemote = globalThis as typeof globalThis & {
  __ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__?: string;
};

function params() {
  return {
    setActionNotice: vi.fn(),
    loadWalletConfig: vi.fn(async () => {}),
    t: (key: string) => key,
  };
}

describe("useCloudState Android hosted auth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.browserFinished = null;
    harness.cancel.mockClear();
    harness.directCloudRequest.mockReset();
    harness.begin.mockReset();
    harness.begin.mockImplementation(async () => {
      harness.sequence += 1;
      return {
        state: `attempt-${harness.sequence}`,
        browserUrl: "https://cloud.eliza.app/login",
      };
    });
    harness.sequence = 0;
    harness.stewardToken = null;
    harness.switchAccountPending = false;
    for (const method of Object.values(harness.api)) method.mockClear();
  });

  afterEach(() => {
    delete runtimeWithPinnedRemote.__ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__;
    vi.useRealTimers();
  });

  it("cancels a dismissed Custom Tab and permits an immediate retry", async () => {
    const { result } = renderHook(() => useCloudState(params()));

    let first: Promise<void> | undefined;
    act(() => {
      first = result.current.handleCloudLogin();
    });
    await act(async () => {
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
    expect(harness.browserFinished).toBeTypeOf("function");
    act(() => harness.browserFinished?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
      await first;
    });
    expect(harness.cancel).toHaveBeenCalledWith("attempt-1");
    expect(result.current.elizaCloudLoginBusy).toBe(false);

    let second: Promise<void> | undefined;
    act(() => {
      second = result.current.handleCloudLogin();
    });
    await act(async () => {
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
    expect(harness.sequence).toBe(2);
    act(() => harness.browserFinished?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
      await second;
    });
    expect(harness.cancel).toHaveBeenCalledWith("attempt-2");
    expect(result.current.elizaCloudLoginBusy).toBe(false);
  });

  it("preserves account-switch intent across hook recreation", async () => {
    harness.switchAccountPending = true;
    const first = renderHook(() => useCloudState(params()));
    first.unmount();
    const recreated = renderHook(() => useCloudState(params()));

    let login: Promise<void> | undefined;
    act(() => {
      login = recreated.result.current.handleCloudLogin();
    });
    await act(async () => {
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
    expect(harness.begin).toHaveBeenCalledWith("https://eliza.app", {
      switchAccount: true,
    });
    act(() => harness.browserFinished?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
      await login;
    });
  });

  it("does not cancel a callback that starts before the browser-close grace expires", async () => {
    const { result } = renderHook(() => useCloudState(params()));

    let login: Promise<void> | undefined;
    act(() => {
      login = result.current.handleCloudLogin();
    });
    await act(async () => {
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
    act(() => harness.browserFinished?.());
    act(() => {
      window.dispatchEvent(
        new CustomEvent("eliza:android-cloud-auth-started", {
          detail: { attemptId: "attempt-1" },
        }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(harness.cancel).not.toHaveBeenCalled();
    expect(result.current.elizaCloudLoginBusy).toBe(true);

    act(() => {
      window.dispatchEvent(
        new CustomEvent("eliza:android-cloud-auth-result", {
          detail: {
            apiBase: "https://api.eliza.app",
            attemptId: "attempt-1",
            ok: true,
          },
        }),
      );
    });
    await act(async () => {
      await login;
    });
    expect(harness.cancel).not.toHaveBeenCalled();
    expect(result.current.elizaCloudLoginBusy).toBe(false);
  });

  it("restores a committed token without depending on pending-login cleanup", async () => {
    harness.stewardToken = "durable-steward-token";
    const { result } = renderHook(() => useCloudState(params()));

    await act(async () => {
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    expect(result.current.elizaCloudConnected).toBe(true);
    expect(harness.api.setToken).toHaveBeenCalledWith("durable-steward-token");
    expect(harness.api.getCloudStatus).toHaveBeenCalled();
  });

  it("keeps the native Steward token when direct reconciliation is transient", async () => {
    runtimeWithPinnedRemote.__ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__ =
      "https://bot.nubs.site";
    harness.stewardToken = "durable-steward-token";
    harness.directCloudRequest.mockRejectedValueOnce(
      new Error("control plane unavailable"),
    );
    const { result } = renderHook(() => useCloudState(params()));

    await act(async () => {
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });

    expect(harness.directCloudRequest).toHaveBeenCalled();
    expect(result.current.elizaCloudConnected).toBe(false);
    expect(result.current.elizaCloudLoginError).toBe(
      "Eliza Cloud is temporarily unavailable. Retry in a moment.",
    );
    expect(result.current.elizaCloudLoginError).not.toContain("sign in again");
    expect(harness.stewardToken).toBe("durable-steward-token");
  });

  it("rejects required-client-auth callers when hosted sign-in cannot start", async () => {
    harness.begin.mockRejectedValueOnce(
      new Error("Eliza Cloud sign-in is not configured for this app yet."),
    );
    const { result } = renderHook(() => useCloudState(params()));

    let rejected: unknown;
    await act(async () => {
      try {
        await result.current.handleCloudLogin(null, {
          requireClientAuth: true,
        });
      } catch (error) {
        rejected = error;
      }
    });
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toContain(
      "Eliza Cloud sign-in is not configured",
    );
    expect(result.current.elizaCloudLoginBusy).toBe(false);
    expect(result.current.elizaCloudLoginError).toContain("not configured");
  });
});
