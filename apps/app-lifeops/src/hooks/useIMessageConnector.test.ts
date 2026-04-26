// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock, statusResponse } =
  vi.hoisted(() => {
    const statusResponse = {
      available: true,
      connected: true,
      bridgeType: "native" as const,
      hostPlatform: "darwin" as const,
      accountHandle: null,
      sendMode: "apple-script" as const,
      helperConnected: null,
      privateApiEnabled: null,
      diagnostics: ["full_disk_access_required"],
      lastSyncAt: null,
      lastCheckedAt: "2026-04-17T18:00:00.000Z",
      error: null,
    };

    return {
      clientMock: {
        getIMessageConnectorStatus: vi.fn(async () => statusResponse),
        getLifeOpsFullDiskAccessStatus: vi.fn(async () => ({
          status: "revoked" as const,
          checkedAt: "2026-04-23T15:00:00.000Z",
          chatDbPath: "/Users/test/Library/Messages/chat.db",
          reason: "Full Disk Access is required to read chat.db.",
        })),
      },
      statusResponse,
    };
  });

vi.mock("@elizaos/app-core", () => ({ client: clientMock }));

import { useIMessageConnector } from "./useIMessageConnector.js";

describe("useIMessageConnector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.getIMessageConnectorStatus.mockResolvedValue(statusResponse);
    clientMock.getLifeOpsFullDiskAccessStatus.mockResolvedValue({
      status: "revoked",
      checkedAt: "2026-04-23T15:00:00.000Z",
      chatDbPath: "/Users/test/Library/Messages/chat.db",
      reason: "Full Disk Access is required to read chat.db.",
    });
  });

  it("loads connector status plus Mac support state on mount", async () => {
    const { result } = renderHook(() => useIMessageConnector());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status?.bridgeType).toBe("native");
    expect(result.current.status?.hostPlatform).toBe("darwin");
    expect(result.current.fullDiskAccess?.status).toBe("revoked");
    expect(clientMock.getIMessageConnectorStatus).toHaveBeenCalledTimes(1);
    expect(clientMock.getLifeOpsFullDiskAccessStatus).toHaveBeenCalledTimes(1);
  });

  it("refreshes native status without shell installer side effects", async () => {
    const { result } = renderHook(() => useIMessageConnector());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refresh();
    });

    expect(clientMock.getIMessageConnectorStatus).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });
});
