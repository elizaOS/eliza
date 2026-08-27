/**
 * Unit tests for the WeChat `ConnectorAccountProvider` against a mocked
 * runtime: direct-account discovery from config, the observational status
 * policy (configuration alone yields "pending"; "connected" requires an
 * observed health state; failure states surface as "error"), and the
 * no-config case. No network.
 */
import type { ConnectorAccountManager, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createWechatConnectorAccountProvider } from "./connector-account-provider";

const manager = {} as ConnectorAccountManager;

function runtimeWithConfig(config: unknown): IAgentRuntime {
  return {
    character: { settings: { connectors: { wechat: config } } },
    getSetting: vi.fn(() => undefined),
  } as unknown as IAgentRuntime;
}

describe("createWechatConnectorAccountProvider", () => {
  it("returns no accounts when WeChat is not configured", async () => {
    const runtime = {
      character: { settings: {} },
      getSetting: vi.fn(() => undefined),
    } as unknown as IAgentRuntime;
    const provider = createWechatConnectorAccountProvider(runtime);

    await expect(provider.listAccounts?.(manager)).resolves.toEqual([]);
  });

  it("surfaces a direct official-account config as pending without observation", async () => {
    const provider = createWechatConnectorAccountProvider(
      runtimeWithConfig({
        account: {
          mode: "official-account",
          appId: "wx1234",
          appSecret: "sec",
          token: "tok",
        },
      }),
    );

    await expect(provider.listAccounts?.(manager)).resolves.toEqual([
      expect.objectContaining({
        id: "default",
        provider: "wechat",
        status: "pending",
        externalId: "wx1234",
        metadata: expect.objectContaining({ mode: "official-account" }),
      }),
    ]);
  });

  it("reports connected only from an observed health state", async () => {
    const provider = createWechatConnectorAccountProvider(
      runtimeWithConfig({
        account: {
          mode: "official-account",
          appId: "wx1234",
          appSecret: "sec",
          token: "tok",
        },
      }),
      {
        healthSource: () => new Map([["default", { state: "connected" }]]),
      },
    );

    const accounts = await provider.listAccounts?.(manager);
    expect(accounts?.[0]?.status).toBe("connected");
  });

  it("surfaces an unavailable transport as error, never fake-healthy", async () => {
    const provider = createWechatConnectorAccountProvider(
      runtimeWithConfig({
        accounts: {
          corp: {
            mode: "wecom",
            corpId: "corp1",
            agentId: 7,
            corpSecret: "sec",
            token: "tok",
            encodingAESKey: "K".repeat(43),
          },
        },
      }),
      {
        healthSource: () => new Map([["corp", { state: "unavailable" }]]),
      },
    );

    const accounts = await provider.listAccounts?.(manager);
    expect(accounts?.[0]?.status).toBe("error");
    expect(accounts?.[0]?.id).toBe("corp");
  });

  it("marks disabled accounts disabled regardless of health", async () => {
    const provider = createWechatConnectorAccountProvider(
      runtimeWithConfig({
        accounts: {
          off: {
            enabled: false,
            mode: "official-account",
            appId: "wx1",
            appSecret: "s",
            token: "t",
          },
        },
      }),
      {
        healthSource: () => new Map([["off", { state: "connected" }]]),
      },
    );

    const accounts = await provider.listAccounts?.(manager);
    expect(accounts?.[0]?.status).toBe("disabled");
  });

  it("never copies secrets into account metadata", async () => {
    const provider = createWechatConnectorAccountProvider(
      runtimeWithConfig({
        account: {
          mode: "official-account",
          appId: "wx1234",
          appSecret: "super-secret",
          token: "tok-secret",
        },
      }),
    );

    const accounts = await provider.listAccounts?.(manager);
    const serialized = JSON.stringify(accounts);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("tok-secret");
  });

  it("production wiring feeds channel evidence through the health source", async () => {
    // Simulate the closure src/index.ts installs: the provider reads the
    // live channel evidence lazily at listAccounts time.
    let evidence: Array<{ accountId: string; health?: { state: string } }> = [];
    const provider = createWechatConnectorAccountProvider(
      runtimeWithConfig({
        account: {
          mode: "official-account",
          appId: "wx1234",
          appSecret: "sec",
          token: "tok",
        },
      }),
      {
        healthSource: () => {
          const map = new Map<string, { state: string }>();
          for (const e of evidence) {
            if (e.health) map.set(e.accountId, e.health);
          }
          return map;
        },
      },
    );

    // Before any observation: pending.
    expect((await provider.listAccounts?.(manager))?.[0]?.status).toBe(
      "pending",
    );
    // After a verified-callback observation through the same source: connected.
    evidence = [{ accountId: "default", health: { state: "connected" } }];
    expect((await provider.listAccounts?.(manager))?.[0]?.status).toBe(
      "connected",
    );
  });
});
