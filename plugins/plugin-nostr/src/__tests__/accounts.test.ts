import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { resolveDefaultNostrAccountId, resolveNostrAccountSettings } from "../accounts.js";
import { NostrService } from "../service.js";

function runtime(settings: Record<string, string>): IAgentRuntime {
  return {
    character: { settings: {} },
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  } as unknown as IAgentRuntime;
}

describe("Nostr account config", () => {
  it("preserves legacy env settings as the default account", () => {
    const rt = runtime({
      NOSTR_PRIVATE_KEY: "a".repeat(64),
      NOSTR_RELAYS: "wss://relay.example.com",
    });

    expect(resolveDefaultNostrAccountId(rt)).toBe("default");
    expect(resolveNostrAccountSettings(rt).accountId).toBe("default");
    expect(resolveNostrAccountSettings(rt).relays).toEqual(["wss://relay.example.com"]);
  });

  it("resolves named accounts from NOSTR_ACCOUNTS", () => {
    const rt = runtime({
      NOSTR_DEFAULT_ACCOUNT_ID: "publishing",
      NOSTR_ACCOUNTS: JSON.stringify({
        publishing: {
          privateKey: "b".repeat(64),
          relays: ["wss://relay.two.example.com"],
        },
      }),
    });

    const settings = resolveNostrAccountSettings(rt);
    expect(settings.accountId).toBe("publishing");
    expect(settings.privateKey).toBe("b".repeat(64));
  });
});

describe("Nostr message connector accounts", () => {
  it("registers one DM and post connector for each started account", () => {
    const registerMessageConnector = vi.fn((registration: { accountId?: string }) => {
      void registration;
    });
    const registerPostConnector = vi.fn();
    const rt = {
      agentId: "agent-1",
      registerMessageConnector,
      registerPostConnector,
      registerSendHandler: vi.fn(),
      logger: { info: vi.fn() },
      getSetting: vi.fn(() => null),
    } as unknown as IAgentRuntime;
    const service = Object.create(NostrService.prototype) as NostrService;
    const primary = Object.create(NostrService.prototype) as NostrService;
    const secondary = Object.create(NostrService.prototype) as NostrService;
    Object.assign(primary, {
      settings: {
        accountId: "primary",
        publicKey: "a".repeat(64),
        relays: ["wss://relay.one.example.com"],
        allowFrom: [],
      },
    });
    Object.assign(secondary, {
      settings: {
        accountId: "secondary",
        publicKey: "b".repeat(64),
        relays: ["wss://relay.two.example.com"],
        allowFrom: [],
      },
    });
    Object.assign(service, {
      accountServices: new Map([
        ["primary", primary],
        ["secondary", secondary],
      ]),
    });

    NostrService.registerSendHandlers(rt, service);

    expect(registerMessageConnector).toHaveBeenCalledTimes(2);
    expect(registerPostConnector).toHaveBeenCalledTimes(2);
    expect(
      registerMessageConnector.mock.calls.map(([registration]) => registration.accountId)
    ).toEqual(["primary", "secondary"]);
  });
});
