/** Verifies useHomeModelStatus through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Unit coverage for the home-surface model-status hook: it stays `not-required`
 * for external runtimes, tracks local readiness, and releases a stale local
 * gate after deferred Cloud registration. Network seams are mocked in jsdom.
 */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOBILE_RUNTIME_MODE_CHANGED_EVENT } from "../../events";
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
  getModelsConfig: vi.fn(),
  getConfig: vi.fn(),
  getLocalInferenceHub: vi.fn(),
}));

const eventSourceMock = vi.hoisted(() => ({
  openEventSource: vi.fn(() => ({ close: vi.fn() })),
}));

// Auth gate (#11084): the hook must stay dormant until the shared auth
// snapshot reports an authenticated session. Mutable so tests can flip it.
const authMock = vi.hoisted(() => ({ authenticated: true }));
const mobileRuntimeModeMock = vi.hoisted(() => ({
  value: null as
    | "remote-mac"
    | "cloud"
    | "cloud-hybrid"
    | "local"
    | "tunnel-to-mobile"
    | null,
}));

vi.mock("../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => authMock.authenticated,
}));

vi.mock("../../hooks/useRuntimeMode", () => ({
  useRuntimeMode: () => runtimeModeMock.value,
}));

vi.mock("../../first-run/mobile-runtime-mode", async (importOriginal) => ({
  ...(await importOriginal()),
  readPersistedMobileRuntimeMode: () => mobileRuntimeModeMock.value,
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
  clientMock.getModelsConfig.mockResolvedValue({});
  clientMock.getConfig.mockResolvedValue({
    serviceRouting: {
      llmText: { backend: "ollama", transport: "direct" },
    },
  });
  clientMock.getLocalInferenceHub.mockResolvedValue(emptyHub);
  eventSourceMock.openEventSource.mockClear();
  authMock.authenticated = true;
  mobileRuntimeModeMock.value = null;
  setRuntimeMode("local");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useHomeModelStatus", () => {
  it.each(["loading", "cloud", "remote"] as const)(
    "does not poll local inference while runtime mode is %s",
    async (mode) => {
      setRuntimeMode(mode);

      const { result } = renderHook(() => useHomeModelStatus());

      await waitFor(() => {
        expect(result.current.kind).toBe("not-required");
      });
      expect(clientMock.getLocalInferenceHub).not.toHaveBeenCalled();
      expect(eventSourceMock.openEventSource).not.toHaveBeenCalled();
    },
  );

  it.each(["remote-mac", "tunnel-to-mobile"] as const)(
    "does not poll phone-local inference for %s placement on a local Mac server",
    async (mobileRuntimeMode) => {
      mobileRuntimeModeMock.value = mobileRuntimeMode;

      const { result } = renderHook(() => useHomeModelStatus());

      await waitFor(() => {
        expect(result.current.kind).toBe("not-required");
      });
      expect(clientMock.getModelsConfig).not.toHaveBeenCalled();
      expect(clientMock.getLocalInferenceHub).not.toHaveBeenCalled();
      expect(eventSourceMock.openEventSource).not.toHaveBeenCalled();
    },
  );

  it("stops phone-local readiness tracking when placement switches to remote Mac", async () => {
    const { result } = renderHook(() => useHomeModelStatus());

    await waitFor(() => {
      expect(clientMock.getLocalInferenceHub).toHaveBeenCalledTimes(1);
    });
    const stream = eventSourceMock.openEventSource.mock.results[0]?.value;

    act(() => {
      mobileRuntimeModeMock.value = "remote-mac";
      document.dispatchEvent(
        new CustomEvent(MOBILE_RUNTIME_MODE_CHANGED_EVENT, {
          detail: { mode: "remote-mac" },
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.kind).toBe("not-required");
    });
    expect(stream?.close).toHaveBeenCalledTimes(1);
  });

  it("starts phone-local readiness tracking when placement switches back to local", async () => {
    mobileRuntimeModeMock.value = "remote-mac";
    renderHook(() => useHomeModelStatus());

    expect(clientMock.getLocalInferenceHub).not.toHaveBeenCalled();

    act(() => {
      mobileRuntimeModeMock.value = "local";
      document.dispatchEvent(
        new CustomEvent(MOBILE_RUNTIME_MODE_CHANGED_EVENT, {
          detail: { mode: "local" },
        }),
      );
    });

    await waitFor(() => {
      expect(clientMock.getLocalInferenceHub).toHaveBeenCalledTimes(1);
    });
    expect(eventSourceMock.openEventSource).toHaveBeenCalledTimes(1);
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

  it("does not gate a local runtime whose active text route is Cerebras", async () => {
    clientMock.getModelsConfig.mockResolvedValue({
      activeChat: {
        provider: "cerebras",
        family: "OPENAI",
        endpoint: "https://api.cerebras.ai/v1",
      },
    });

    const { result } = renderHook(() => useHomeModelStatus());

    await waitFor(() => {
      expect(result.current.kind).toBe("not-required");
    });
    expect(clientMock.getModelsConfig).toHaveBeenCalledTimes(1);
    expect(clientMock.getLocalInferenceHub).not.toHaveBeenCalled();
    expect(eventSourceMock.openEventSource).not.toHaveBeenCalled();
  });

  it("clears a stale local gate after deferred Eliza Cloud registration", async () => {
    clientMock.getModelsConfig.mockResolvedValueOnce({}).mockResolvedValue({
      activeChat: {
        provider: "elizacloud",
        family: "ELIZAOS_CLOUD",
        endpoint: "https://api.eliza.app/v1",
      },
    });
    clientMock.getConfig.mockResolvedValue({
      serviceRouting: {
        llmText: { backend: "elizacloud", transport: "cloud-proxy" },
      },
    });
    clientMock.getLocalInferenceHub.mockResolvedValue({
      textReadiness: {
        slots: {
          TEXT_SMALL: {
            slot: "TEXT_SMALL",
            assigned: true,
            assignedModelId: "eliza-1-2b",
            displayName: "Eliza 1 2B",
            primaryDownloaded: false,
            downloaded: false,
            active: false,
            ready: false,
            state: "missing",
            requiredModelIds: ["eliza-1-2b"],
            missingModelIds: ["eliza-1-2b"],
            installedBytes: 0,
            expectedBytes: 0,
            download: {
              state: "missing",
              receivedBytes: 0,
              totalBytes: 0,
              percent: null,
              bytesPerSec: 0,
              etaMs: null,
              updatedAt: null,
              errors: [],
            },
            errors: [],
          },
        },
      },
    });

    const { result } = renderHook(() => useHomeModelStatus());

    await waitFor(() => {
      expect(result.current.kind).toBe("missing");
      expect(result.current.blocksSend).toBe(true);
    });

    await waitFor(
      () => {
        expect(clientMock.getModelsConfig).toHaveBeenCalledTimes(2);
      },
      { timeout: 2_500 },
    );
    expect(result.current.kind).toBe("not-required");
    expect(result.current.blocksSend).toBe(false);
    const stream = eventSourceMock.openEventSource.mock.results[0]?.value;
    expect(stream?.close).toHaveBeenCalledTimes(1);
  });

  it("fails closed and stops local tracking when the deferred route probe fails", async () => {
    clientMock.getModelsConfig
      .mockResolvedValueOnce({})
      .mockRejectedValue(new Error("route unavailable"));
    clientMock.getConfig.mockResolvedValue({
      serviceRouting: {
        llmText: { backend: "elizacloud", transport: "cloud-proxy" },
      },
    });

    const { result } = renderHook(() => useHomeModelStatus());

    await waitFor(
      () => {
        expect(result.current.kind).toBe("error");
      },
      { timeout: 2_500 },
    );
    expect(result.current.blocksSend).toBe(true);
    const stream = eventSourceMock.openEventSource.mock.results[0]?.value;
    expect(stream?.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces a routing probe failure instead of inventing local readiness", async () => {
    clientMock.getModelsConfig.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useHomeModelStatus());

    await waitFor(() => {
      expect(result.current.kind).toBe("error");
    });
    expect(result.current.errors).toEqual([
      "Could not verify the active text model provider.",
    ]);
    expect(clientMock.getLocalInferenceHub).not.toHaveBeenCalled();
    expect(eventSourceMock.openEventSource).not.toHaveBeenCalled();
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
