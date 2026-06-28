// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeModeMock = vi.hoisted(() => ({
  value: {
    state: { phase: "ready" as const },
    mode: "local" as const,
    isLocalOnly: true,
    isCloudMode: false,
    isRemoteMode: false,
    refetch: vi.fn(),
  },
}));

const clientMock = vi.hoisted(() => ({
  getBaseUrl: vi.fn(() => "http://127.0.0.1:31337"),
  getLocalInferenceHub: vi.fn(),
}));

const eventSourceMock = vi.hoisted(() => ({
  openEventSource: vi.fn(() => ({ close: vi.fn() })),
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
});
