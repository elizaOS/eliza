// @vitest-environment jsdom

import {
  type ElectrobunRendererRpc,
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent,
} from "@elizaos/app-core/bridge";
import { afterEach, describe, expect, it, vi } from "vitest";

type TestWindow = Window & {
  __MILADY_ELECTROBUN_RPC__?: ElectrobunRendererRpc;
};

describe("electrobun rpc bridge", () => {
  afterEach(() => {
    delete (window as TestWindow).__MILADY_ELECTROBUN_RPC__;
    vi.restoreAllMocks();
  });

  it("prefers direct Electrobun RPC requests when available", async () => {
    const rpcRequest = vi.fn().mockResolvedValue({ ok: true });
    (window as TestWindow).__MILADY_ELECTROBUN_RPC__ = {
      request: { desktopOpenExternal: rpcRequest },
      onMessage: vi.fn(),
      offMessage: vi.fn(),
    };

    await expect(
      invokeDesktopBridgeRequest({
        rpcMethod: "desktopOpenExternal",
        ipcChannel: "desktop:openExternal",
        params: { url: "https://example.com" },
      }),
    ).resolves.toEqual({ ok: true });

    expect(rpcRequest).toHaveBeenCalledWith({ url: "https://example.com" });
  });

  it("returns null when direct Electrobun RPC is unavailable", async () => {
    await expect(
      invokeDesktopBridgeRequest({
        rpcMethod: "desktopOpenExternal",
        ipcChannel: "desktop:openExternal",
        params: { url: "https://example.com" },
      }),
    ).resolves.toBeNull();
  });

  it("subscribes to direct Electrobun RPC messages when available", () => {
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    (window as TestWindow).__MILADY_ELECTROBUN_RPC__ = {
      request: {},
      onMessage: vi.fn(
        (messageName: string, listener: (payload: unknown) => void) => {
          const entry = listeners.get(messageName) ?? new Set();
          entry.add(listener);
          listeners.set(messageName, entry);
        },
      ),
      offMessage: vi.fn(
        (messageName: string, listener: (payload: unknown) => void) => {
          listeners.get(messageName)?.delete(listener);
        },
      ),
    };

    const listener = vi.fn();
    const unsubscribe = subscribeDesktopBridgeEvent({
      rpcMessage: "contextMenuSaveAsCommand",
      ipcChannel: "contextMenu:saveAsCommand",
      listener,
    });

    listeners.get("contextMenuSaveAsCommand")?.forEach((fn) => {
      fn({ text: "hello" });
    });

    expect(listener).toHaveBeenCalledWith({ text: "hello" });

    unsubscribe();
    expect(listeners.get("contextMenuSaveAsCommand")?.size ?? 0).toBe(0);
  });
});
