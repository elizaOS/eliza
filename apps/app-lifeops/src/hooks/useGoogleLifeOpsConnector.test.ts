// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  clientMock,
  dispatchLifeOpsGoogleConnectorRefreshMock,
  openExternalUrlMock,
  reactModuleUrl,
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
      getGoogleLifeOpsConnectorAccounts: vi.fn(async () => []),
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
    reactModuleUrl: `${process.cwd()}/node_modules/react/index.js`,
  };
});

vi.mock("@elizaos/app-core/api", () => ({ client: clientMock }));
vi.mock("@elizaos/app-core/state", () => ({ useApp: useAppMock }));
vi.mock("@elizaos/app-core/utils", () => ({
  openExternalUrl: openExternalUrlMock,
}));
vi.mock("react", async () => import(reactModuleUrl));
vi.mock("@elizaos/app-core/events", () => ({
  APP_RESUME_EVENT: "app-resume",
}));
vi.mock("../events/index.js", () => ({
  LIFEOPS_GOOGLE_CONNECTOR_REFRESH_EVENT: "lifeops-google-connector-refresh",
  dispatchLifeOpsGoogleConnectorRefresh:
    dispatchLifeOpsGoogleConnectorRefreshMock,
}));

import { useGoogleLifeOpsConnector } from "./useGoogleLifeOpsConnector";

describe("useGoogleLifeOpsConnector - pendingAuthUrl state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.getGoogleLifeOpsConnectorStatus.mockResolvedValue(
      clientMock.disconnectedStatus,
    );
    clientMock.getGoogleLifeOpsConnectorAccounts.mockResolvedValue([]);
    openExternalUrlMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("skips account fetches unless includeAccounts is enabled", async () => {
    const firstHook = renderHook(() => useGoogleLifeOpsConnector());
    await waitFor(() => expect(firstHook.result.current.loading).toBe(false));

    expect(clientMock.getGoogleLifeOpsConnectorStatus).toBeCalledTimes(1);
    expect(clientMock.getGoogleLifeOpsConnectorAccounts).not.toHaveBeenCalled();

    firstHook.unmount();
    vi.clearAllMocks();
    clientMock.getGoogleLifeOpsConnectorStatus.mockResolvedValue(
      clientMock.disconnectedStatus,
    );
    clientMock.getGoogleLifeOpsConnectorAccounts.mockResolvedValue([]);

    const secondHook = renderHook(() =>
      useGoogleLifeOpsConnector({ includeAccounts: true }),
    );
    await waitFor(() =>
      expect(clientMock.getGoogleLifeOpsConnectorStatus).toHaveBeenCalledTimes(
        1,
      ),
    );
    expect(clientMock.getGoogleLifeOpsConnectorAccounts).toHaveBeenCalledTimes(
      1,
    );
    secondHook.unmount();
  });

  it("coalesces bursty silent refresh signals into one request", async () => {
    vi.useFakeTimers();

    const hook = renderHook(() => useGoogleLifeOpsConnector());
    await act(async () => {
      await Promise.resolve();
    });
    expect(clientMock.getGoogleLifeOpsConnectorStatus).toHaveBeenCalledTimes(1);
    clientMock.getGoogleLifeOpsConnectorStatus.mockClear();
    clientMock.getGoogleLifeOpsConnectorAccounts.mockClear();

    act(() => {
      for (let index = 0; index < 3; index += 1) {
        window.dispatchEvent(
          new CustomEvent("lifeops-google-connector-refresh", {
            detail: {
              side: "owner",
              source: "callback",
            },
          }),
        );
      }
    });

    expect(clientMock.getGoogleLifeOpsConnectorStatus).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(
      clientMock.getGoogleLifeOpsConnectorStatus.mock.calls.length,
    ).toBeLessThan(3);
    expect(clientMock.getGoogleLifeOpsConnectorAccounts).not.toHaveBeenCalled();
    hook.unmount();
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

  it("connect() requests inbox tracking without Gmail manage scopes", async () => {
    const { result } = renderHook(() => useGoogleLifeOpsConnector());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.connect();
    });

    const [request] =
      clientMock.startGoogleLifeOpsConnector.mock.calls[0] ?? [];
    expect(request?.capabilities).toContain("google.gmail.triage");
    expect(request?.capabilities).not.toContain("google.gmail.manage");
  });

  it("connectAdditional() requests inbox tracking without Gmail manage scopes", async () => {
    clientMock.getGoogleLifeOpsConnectorStatus.mockResolvedValue(
      clientMock.connectedStatus,
    );
    const { result } = renderHook(() => useGoogleLifeOpsConnector());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.connectAdditional();
    });

    const [request] =
      clientMock.startGoogleLifeOpsConnector.mock.calls[0] ?? [];
    expect(request?.capabilities).toContain("google.gmail.triage");
    expect(request?.capabilities).not.toContain("google.gmail.manage");
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
