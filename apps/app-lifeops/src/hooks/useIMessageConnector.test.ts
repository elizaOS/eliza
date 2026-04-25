// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock, reactModuleUrl, statusResponse, terminalRunMock } =
  vi.hoisted(() => {
    const statusResponse = {
      available: true,
      connected: true,
      bridgeType: "bluebubbles" as const,
      hostPlatform: "darwin" as const,
      accountHandle: "shawmakesmusic@gmail.com",
      sendMode: "apple-script" as const,
      helperConnected: false,
      privateApiEnabled: true,
      diagnostics: ["bluebubbles_helper_disconnected"],
      lastSyncAt: null,
      lastCheckedAt: "2026-04-17T18:00:00.000Z",
      error: null,
    };

    return {
      clientMock: {
        fetch: vi.fn(),
        getIMessageConnectorStatus: vi.fn(async () => statusResponse),
        getLifeOpsFullDiskAccessStatus: vi.fn(async () => ({
          status: "revoked" as const,
          checkedAt: "2026-04-23T15:00:00.000Z",
          chatDbPath: "/Users/test/Library/Messages/chat.db",
          reason: "Full Disk Access is required to read chat.db.",
        })),
        isShellEnabled: vi.fn(async () => true),
        restartAndWait: vi.fn(async () => ({
          status: "running",
        })),
        updateConfig: vi.fn(async () => ({})),
      },
      reactModuleUrl: `${process.cwd()}/node_modules/react/index.js`,
      statusResponse,
      terminalRunMock: vi.fn(),
    };
  });

vi.mock("react", async () => import(reactModuleUrl));
vi.mock("@elizaos/app-core/api", () => ({ client: clientMock }));

import { useIMessageConnector } from "./useIMessageConnector.js";

describe("useIMessageConnector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.getIMessageConnectorStatus.mockResolvedValue(statusResponse);
    clientMock.isShellEnabled.mockResolvedValue(true);
    clientMock.getLifeOpsFullDiskAccessStatus.mockResolvedValue({
      status: "revoked",
      checkedAt: "2026-04-23T15:00:00.000Z",
      chatDbPath: "/Users/test/Library/Messages/chat.db",
      reason: "Full Disk Access is required to read chat.db.",
    });
    terminalRunMock.mockReset();
    clientMock.fetch.mockImplementation(
      async (
        path: string,
        init?: RequestInit,
        options?: { timeoutMs?: number },
      ) => {
        if (path !== "/api/terminal/run") {
          throw new Error(`Unexpected fetch path: ${path}`);
        }
        return terminalRunMock(path, init, options);
      },
    );
  });

  it("loads connector status plus Mac support state on mount", async () => {
    const { result } = renderHook(() => useIMessageConnector());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status?.bridgeType).toBe("bluebubbles");
    expect(result.current.status?.hostPlatform).toBe("darwin");
    expect(result.current.shellEnabled).toBe(true);
    expect(result.current.fullDiskAccess?.status).toBe("revoked");
    expect(clientMock.getIMessageConnectorStatus).toHaveBeenCalledTimes(1);
    expect(clientMock.isShellEnabled).toHaveBeenCalledTimes(1);
    expect(clientMock.getLifeOpsFullDiskAccessStatus).toHaveBeenCalledTimes(1);
  });

  it("installs imsg, saves the resolved cli path, restarts the agent, and refreshes status", async () => {
    terminalRunMock
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        stdout: "==> Installing imsg\n",
        stderr: "",
        timedOut: false,
        truncated: false,
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        stdout: "/opt/homebrew/bin/imsg\n",
        stderr: "",
        timedOut: false,
        truncated: false,
      });

    const { result } = renderHook(() => useIMessageConnector());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.installImsg();
    });

    expect(clientMock.fetch).toHaveBeenCalledTimes(2);
    expect(clientMock.updateConfig).toHaveBeenCalledWith({
      connectors: {
        imessage: {
          cliPath: "/opt/homebrew/bin/imsg",
          enabled: true,
        },
      },
    });
    expect(clientMock.restartAndWait).toHaveBeenCalledWith(45_000);
    expect(clientMock.getIMessageConnectorStatus).toHaveBeenCalledTimes(2);
    expect(result.current.actionPending).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
