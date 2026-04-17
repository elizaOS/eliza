// @vitest-environment jsdom

import { renderHook, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock, reactModuleUrl } = vi.hoisted(() => ({
  clientMock: {
    getIMessageConnectorStatus: vi.fn(async () => ({
      available: true,
      connected: true,
      bridgeType: "bluebubbles" as const,
      accountHandle: "shawmakesmusic@gmail.com",
      lastSyncAt: null,
      lastCheckedAt: "2026-04-17T18:00:00.000Z",
      error: null,
    })),
  },
  reactModuleUrl: `${process.cwd()}/node_modules/react/index.js`,
}));

vi.mock("react", async () => import(reactModuleUrl));
vi.mock("@elizaos/app-core/api", () => ({ client: clientMock }));

import { useIMessageConnector } from "./useIMessageConnector.js";

describe("useIMessageConnector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads connector status on mount and refreshes on demand", async () => {
    const { result } = renderHook(() => useIMessageConnector());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status?.bridgeType).toBe("bluebubbles");
    expect(clientMock.getIMessageConnectorStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh();
    });

    expect(clientMock.getIMessageConnectorStatus).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });
});
