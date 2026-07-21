// @vitest-environment jsdom

/**
 * Unit coverage for the home-surface model-status hook: it stays `not-required`
 * for cloud/remote/unauthenticated runtimes and derives readiness from the hub
 * fetch. Runtime-mode and the API client are mocked (jsdom, no network).
 */

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseRuntimeModeResult } from "../../hooks/useRuntimeMode";

const runtimeModeMock = vi.hoisted(() => ({
  // Typed as the full union so setRuntimeMode() can swap between the loading /
  // ready variants without the initial literal narrowing `value`'s type. The
  // initial value is the loading variant (a valid union member needing no
  // snapshot); beforeEach() resets it to "local" before every test.
  value: {
    state: { phase: "loading" as const },
    mode: null,
    isLocalOnly: false,
    isCloudMode: false,
    isRemoteMode: false,
    refetch: vi.fn(),
  } as UseRuntimeModeResult,
}));

const clientMock = vi.hoisted(() => ({
  getBaseUrl: vi.fn(() => "http://127.0.0.1:31337"),
  getLocalInferenceHub: vi.fn(),
}));

const eventSourceMock = vi.hoisted(() => ({
  openEventSource: vi.fn(() => ({ close: vi.fn() })),
}));

// Auth gate (#11084): the hook must stay dormant until the shared auth
// snapshot reports an authenticated session. Mutable so tests can flip it.
const authMock = vi.hoisted(() => ({ authenticated: true }));

vi.mock("../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => authMock.authenticated,
}));

vi.mock("../../hooks/useRuntimeMode", () => ({
  useRuntimeMode: () => runtimeModeMock.value,
}));

vi.mock("../../api", () => ({
  client: clientMock,
}));

vi.mock("../../utils/asset-url", () => ({
  resolveApiUrl: (path: string) => path,
}));

vi.mock("../../utils/eliza-globals", () => ({
  getElizaApiToken: () => null,
}));

vi.mock("../../utils/event-source", () => ({
  openEventSource: eventSourceMock.openEventSource,
}));

import { useHomeModelStatus } from "./useHomeModelStatus";

const emptyHub = {
  textReadiness: {
    slots: {},
  },
};

function setRuntimeMode(mode: "loading" | "local" | "cloud" | "remote") {
  runtimeModeMock.value =
    mode === "loading"
      ? {
          state: { phase: "loading" as const },
          mode: null,
          isLocalOnly: false,
          isCloudMode: false,
          isRemoteMode: false,
          refetch: vi.fn(),
        }
      : {
          state: {
            phase: "ready" as const,
            snapshot: {
              mode,
              deploymentRuntime: mode,
              isRemoteController: mode === "remote",
              remoteApiBaseConfigured: mode === "remote",
            },
          },
          mode,
          isLocalOnly: mode === "local",
          isCloudMode: mode === "cloud",
          isRemoteMode: mode === "remote",
          refetch: vi.fn(),
        };
}

beforeEach(() => {
  clientMock.getBaseUrl.mockReturnValue("http://127.0.0.1:31337");
  clientMock.getLocalInferenceHub.mockResolvedValue(emptyHub);
  eventSourceMock.openEventSource.mockClear();
  authMock.authenticated = true;
  setRuntimeMode("local");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useHomeModelStatus", () => {
  it.each([
    "loading",
    "cloud",
    "remote",
  ] as const)("does not poll local inference while runtime mode is %s", async (mode) => {
    setRuntimeMode(mode);

    const { result } = renderHook(() => useHomeModelStatus());

    await waitFor(() => {
      expect(result.current.kind).toBe("not-required");
    });
    expect(clientMock.getLocalInferenceHub).not.toHaveBeenCalled();
    expect(eventSourceMock.openEventSource).not.toHaveBeenCalled();
  });

  it("polls local inference for local runtime mode", async () => {
    renderHook(() => useHomeModelStatus());

    await waitFor(() => {
      expect(clientMock.getLocalInferenceHub).toHaveBeenCalledTimes(1);
    });
    expect(eventSourceMock.openEventSource).toHaveBeenCalledWith(
      "/api/local-inference/downloads/stream",
      { withCredentials: false },
    );
  });

  it("does not poll local inference when the active base is a dedicated cloud agent", async () => {
    clientMock.getBaseUrl.mockReturnValue(
      "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai",
    );

    const { result } = renderHook(() => useHomeModelStatus());

    await waitFor(() => {
      expect(result.current.kind).toBe("not-required");
    });
    expect(clientMock.getLocalInferenceHub).not.toHaveBeenCalled();
    expect(eventSourceMock.openEventSource).not.toHaveBeenCalled();
  });

  // #11084 — the shell mounts this hook before the auth probe resolves; the
  // SSE stream + hub fetch must not fire a single request until the session
  // is authenticated, then start as soon as it flips.
  it("stays dormant while unauthenticated, then starts once the session authenticates", async () => {
    authMock.authenticated = false;

    const { result, rerender } = renderHook(() => useHomeModelStatus());

    await waitFor(() => {
      expect(result.current.kind).toBe("not-required");
    });
    expect(clientMock.getLocalInferenceHub).not.toHaveBeenCalled();
    expect(eventSourceMock.openEventSource).not.toHaveBeenCalled();

    authMock.authenticated = true;
    rerender();

    await waitFor(() => {
      expect(clientMock.getLocalInferenceHub).toHaveBeenCalledTimes(1);
    });
    expect(eventSourceMock.openEventSource).toHaveBeenCalledWith(
      "/api/local-inference/downloads/stream",
      { withCredentials: false },
    );
  });

  it("rechecks the base before polling when startup flips to a dedicated cloud agent", async () => {
    clientMock.getBaseUrl
      .mockReturnValueOnce("http://127.0.0.1:31337")
      .mockReturnValue(
        "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai",
      );

    const { result } = renderHook(() => useHomeModelStatus());

    await waitFor(() => {
      expect(result.current.kind).toBe("not-required");
    });
    expect(clientMock.getLocalInferenceHub).not.toHaveBeenCalled();
    expect(eventSourceMock.openEventSource).not.toHaveBeenCalled();
  });
});
