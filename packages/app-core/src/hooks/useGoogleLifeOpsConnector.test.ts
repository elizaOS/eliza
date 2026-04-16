// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  clientMock,
  dispatchLifeOpsGoogleConnectorRefreshMock,
  openExternalUrlMock,
  useAppMock,
} = vi.hoisted(() => {
  const makeReadyApp = () => ({
    startupPhase: "ready" as const,
    agentStatus: { state: "running" },
    backendConnection: { state: "connected" },
  });
  const disconnectedStatus = {
    connected: false as const,
    mode: "cloud_managed" as const,
    defaultMode: "cloud_managed" as const,
    availableModes: ["cloud_managed"] as const,
    reason: "disconnected" as const,
    identity: null,
    grantedCapabilities: [],
  };
  const connectedStatus = {
    ...disconnectedStatus,
    connected: true as const,
    reason: "connected" as const,
  };
  return {
    clientMock: {
      getBaseUrl: vi.fn(() => "http://127.0.0.1:31337"),
      getGoogleLifeOpsConnectorStatus: vi.fn(async () => disconnectedStatus),
      startGoogleLifeOpsConnector: vi.fn(async () => ({
        authUrl: "https://accounts.google.com/o/oauth2/auth?test=1",
      })),
      selectGoogleLifeOpsConnectorMode: vi.fn(async () => disconnectedStatus),
      disconnectGoogleLifeOpsConnector: vi.fn(async () => undefined),
      connectedStatus,
      disconnectedStatus,
    },
    dispatchLifeOpsGoogleConnectorRefreshMock: vi.fn(),
    openExternalUrlMock: vi.fn(async () => undefined),
    useAppMock: vi.fn(makeReadyApp),
  };
});

vi.mock("../api", () => ({ client: clientMock }));
vi.mock("../state", () => ({ useApp: useAppMock }));
vi.mock("../utils", () => ({
  openExternalUrl: openExternalUrlMock,
}));
vi.mock("../events", () => ({
  LIFEOPS_GOOGLE_CONNECTOR_REFRESH_EVENT: "lifeops-google-connector-refresh",
  APP_RESUME_EVENT: "app-resume",
  dispatchLifeOpsGoogleConnectorRefresh: dispatchLifeOpsGoogleConnectorRefreshMock,
}));

import { useGoogleLifeOpsConnector } from "./useGoogleLifeOpsConnector";

describe("useGoogleLifeOpsConnector - pendingAuthUrl state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.getGoogleLifeOpsConnectorStatus.mockResolvedValue(
      clientMock.disconnectedStatus,
    );
    openExternalUrlMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it("is null on initial render", async () => {
    const { result } = renderHook(() => useGoogleLifeOpsConnector());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pendingAuthUrl).toBeNull();
  });

  it("is set to authUrl after connect() succeeds", async () => {
    const { result } = renderHook(() => useGoogleLifeOpsConnector());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.pendingAuthUrl).toBe(
      "https://accounts.google.com/o/oauth2/auth?test=1",
    );
  });

  it("is cleared when connect() throws", async () => {
    clientMock.startGoogleLifeOpsConnector.mockRejectedValueOnce(
      new Error("network error"),
    );
    const { result } = renderHook(() => useGoogleLifeOpsConnector());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.pendingAuthUrl).toBeNull();
    expect(result.current.error).toBe("network error");
  });

  it("is cleared when refresh() detects connected: true", async () => {
    const { result } = renderHook(() => useGoogleLifeOpsConnector());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.pendingAuthUrl).not.toBeNull();

    clientMock.getGoogleLifeOpsConnectorStatus.mockResolvedValueOnce(
      clientMock.connectedStatus,
    );
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.pendingAuthUrl).toBeNull();
  });

  it("is cleared when selectMode() is called", async () => {
    const { result } = renderHook(() => useGoogleLifeOpsConnector());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.pendingAuthUrl).not.toBeNull();

    await act(async () => {
      await result.current.selectMode("cloud_managed");
    });

    expect(result.current.pendingAuthUrl).toBeNull();
  });

  it("is cleared when disconnect() is called", async () => {
    clientMock.getGoogleLifeOpsConnectorStatus.mockResolvedValue(
      clientMock.connectedStatus,
    );
    const { result } = renderHook(() =>
      useGoogleLifeOpsConnector({ pollWhileDisconnected: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    clientMock.startGoogleLifeOpsConnector.mockResolvedValueOnce({
      authUrl: "https://accounts.google.com/o/oauth2/auth?test=1",
    });
    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.pendingAuthUrl).not.toBeNull();

    clientMock.getGoogleLifeOpsConnectorStatus.mockResolvedValue(
      clientMock.disconnectedStatus,
    );
    await act(async () => {
      await result.current.disconnect();
    });

    expect(result.current.pendingAuthUrl).toBeNull();
  });
});
