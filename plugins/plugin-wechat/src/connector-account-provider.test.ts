/**
 * Unit tests for the WeChat `ConnectorAccountProvider` against a mocked runtime:
 * account discovery from config/env and the unconfigured (no-accounts) case.
 */
import type { ConnectorAccountManager, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createWechatConnectorAccountProvider } from "./connector-account-provider";

const manager = {} as ConnectorAccountManager;

describe("createWechatConnectorAccountProvider", () => {
  it("returns no accounts when WeChat is not configured", async () => {
    const runtime = {
      character: { settings: {} },
      getSetting: vi.fn(() => undefined),
    } as unknown as IAgentRuntime;
    const provider = createWechatConnectorAccountProvider(runtime);

    await expect(provider.listAccounts?.(manager)).resolves.toEqual([]);
  });

  it("surfaces env-configured single-account credentials", async () => {
    const runtime = {
      character: { settings: {} },
      getSetting: vi.fn((key: string) => {
        if (key === "WECHAT_API_KEY") return "wechat-key";
        if (key === "WECHAT_PROXY_URL") return "https://proxy.example.com";
        return undefined;
      }),
    } as unknown as IAgentRuntime;
    const provider = createWechatConnectorAccountProvider(runtime);

    await expect(provider.listAccounts?.(manager)).resolves.toEqual([
      expect.objectContaining({
        id: "default",
        provider: "wechat",
        label: "default",
        role: "AGENT",
        purpose: ["messaging"],
        accessGate: "open",
        status: "connected",
        metadata: expect.objectContaining({
          proxyUrl: "https://proxy.example.com",
        }),
      }),
    ]);
  });
});
