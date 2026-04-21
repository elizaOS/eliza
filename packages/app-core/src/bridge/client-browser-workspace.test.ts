import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeDesktopBridgeRequestMock, isElectrobunRuntimeMock } = vi.hoisted(
  () => ({
    invokeDesktopBridgeRequestMock: vi.fn(),
    isElectrobunRuntimeMock: vi.fn(),
  }),
);

vi.mock("./electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: invokeDesktopBridgeRequestMock,
}));

vi.mock("./electrobun-runtime", () => ({
  isElectrobunRuntime: isElectrobunRuntimeMock,
}));

import { ElizaClient } from "../api/client-base";
import "../api/client-browser-workspace";

describe("client-browser-workspace", () => {
  beforeEach(() => {
    invokeDesktopBridgeRequestMock.mockReset();
    isElectrobunRuntimeMock.mockReset();
  });

  it("prefers the desktop bridge snapshot in Electrobun", async () => {
    isElectrobunRuntimeMock.mockReturnValue(true);
    invokeDesktopBridgeRequestMock.mockResolvedValue({
      mode: "desktop",
      tabs: [
        {
          id: "btab_1",
          title: "discord.com",
          url: "https://discord.com/",
          partition: "persist:browser-workspace",
          visible: true,
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          lastFocusedAt: "2026-04-20T00:00:00.000Z",
        },
      ],
    });

    const client = new ElizaClient("http://example.test");
    const fetchSpy = vi.spyOn(client, "fetch");

    const snapshot = await client.getBrowserWorkspace();

    expect(snapshot.mode).toBe("desktop");
    expect(snapshot.tabs[0]?.url).toBe("https://discord.com/");
    expect(invokeDesktopBridgeRequestMock).toHaveBeenCalledWith({
      rpcMethod: "browserWorkspaceGetSnapshot",
      ipcChannel: "browser-workspace:getSnapshot",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to the HTTP API when the desktop bridge is unavailable", async () => {
    isElectrobunRuntimeMock.mockReturnValue(false);

    const client = new ElizaClient("http://example.test");
    const fetchSpy = vi
      .spyOn(client, "fetch")
      .mockResolvedValue({ mode: "web", tabs: [] });

    const snapshot = await client.getBrowserWorkspace();

    expect(snapshot).toEqual({ mode: "web", tabs: [] });
    expect(invokeDesktopBridgeRequestMock).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith("/api/browser-workspace");
  });
});
