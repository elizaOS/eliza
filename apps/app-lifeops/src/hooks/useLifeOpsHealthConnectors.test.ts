// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock, connectedStatus, disconnectedStatus, openExternalUrlMock } =
  vi.hoisted(() => {
    const disconnectedStatus = {
      provider: "strava" as const,
      side: "owner" as const,
      mode: "local" as const,
      defaultMode: "local" as const,
      availableModes: ["local"] as const,
      executionTarget: "local" as const,
      sourceOfTruth: "local_storage" as const,
      configured: true,
      connected: false,
      reason: "disconnected" as const,
      identity: null,
      grantedCapabilities: ["health.activity.read"] as const,
      grantedScopes: [],
      expiresAt: null,
      hasRefreshToken: false,
      lastSyncAt: null,
      grant: null,
    };
    const connectedStatus = {
      ...disconnectedStatus,
      connected: true,
      reason: "connected" as const,
      identity: { username: "runner" },
      grantedScopes: ["activity:read_all"],
      hasRefreshToken: true,
      lastSyncAt: "2026-04-20T12:00:00.000Z",
    };
    return {
      disconnectedStatus,
      connectedStatus,
      openExternalUrlMock: vi.fn(async () => undefined),
      clientMock: {
        getHealthLifeOpsConnectorStatuses: vi.fn(async () => [
          disconnectedStatus,
        ]),
        startHealthLifeOpsConnector: vi.fn(async () => ({
          provider: "strava" as const,
          side: "owner" as const,
          mode: "local" as const,
          requestedCapabilities: ["health.activity.read"] as const,
          redirectUri: "http://127.0.0.1:31337/callback",
          authUrl: "https://www.strava.com/oauth/authorize?state=test",
        })),
        disconnectHealthLifeOpsConnector: vi.fn(async () => disconnectedStatus),
        syncLifeOpsHealth: vi.fn(async () => ({
          providers: [connectedStatus],
          summaries: [],
          samples: [],
          workouts: [],
          sleepEpisodes: [],
          syncedAt: "2026-04-20T12:00:00.000Z",
        })),
      },
    };
  });

vi.mock("@elizaos/app-core/api", () => ({ client: clientMock }));
vi.mock("@elizaos/app-core/utils", () => ({
  openExternalUrl: openExternalUrlMock,
}));

import { useLifeOpsHealthConnectors } from "./useLifeOpsHealthConnectors";

describe("useLifeOpsHealthConnectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.getHealthLifeOpsConnectorStatuses.mockResolvedValue([
      disconnectedStatus,
    ]);
    clientMock.startHealthLifeOpsConnector.mockResolvedValue({
      provider: "strava",
      side: "owner",
      mode: "local",
      requestedCapabilities: ["health.activity.read"],
      redirectUri: "http://127.0.0.1:31337/callback",
      authUrl: "https://www.strava.com/oauth/authorize?state=test",
    });
    clientMock.disconnectHealthLifeOpsConnector.mockResolvedValue(
      disconnectedStatus,
    );
    clientMock.syncLifeOpsHealth.mockResolvedValue({
      providers: [connectedStatus],
      summaries: [],
      samples: [],
      workouts: [],
      sleepEpisodes: [],
      syncedAt: "2026-04-20T12:00:00.000Z",
    });
    openExternalUrlMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("loads connector statuses without talking to a real provider", async () => {
    const { result, unmount } = renderHook(() => useLifeOpsHealthConnectors());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(clientMock.getHealthLifeOpsConnectorStatuses).toHaveBeenCalledWith(
      undefined,
      "owner",
    );
    expect(result.current.statusesByProvider.strava).toEqual(
      disconnectedStatus,
    );
    expect(result.current.errorByProvider.strava).toBeUndefined();
    unmount();
  });

  it("stores the pending auth URL and opens it when connect starts OAuth", async () => {
    const { result, unmount } = renderHook(() => useLifeOpsHealthConnectors());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.connect("strava", "local");
    });

    expect(clientMock.startHealthLifeOpsConnector).toHaveBeenCalledWith(
      "strava",
      { side: "owner", mode: "local" },
    );
    expect(result.current.pendingAuthUrlByProvider.strava).toBe(
      "https://www.strava.com/oauth/authorize?state=test",
    );
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://www.strava.com/oauth/authorize?state=test",
    );
    unmount();
  });

  it("syncs provider data into local hook state", async () => {
    const { result, unmount } = renderHook(() => useLifeOpsHealthConnectors());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.sync("strava");
    });

    expect(clientMock.syncLifeOpsHealth).toHaveBeenCalledWith({
      provider: "strava",
      side: "owner",
      days: 14,
    });
    expect(result.current.summary?.syncedAt).toBe("2026-04-20T12:00:00.000Z");
    expect(result.current.statusesByProvider.strava?.connected).toBe(true);
    unmount();
  });

  it("fans status load errors out to every provider", async () => {
    clientMock.getHealthLifeOpsConnectorStatuses.mockRejectedValueOnce(
      new Error("status offline"),
    );

    const { result, unmount } = renderHook(() => useLifeOpsHealthConnectors());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.errorByProvider.strava).toBe("status offline");
    expect(result.current.errorByProvider.fitbit).toBe("status offline");
    expect(result.current.errorByProvider.withings).toBe("status offline");
    expect(result.current.errorByProvider.oura).toBe("status offline");
    unmount();
  });
});
