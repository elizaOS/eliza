/**
 * Unit tests for the ConnectorAccountManager provider: that a bot-token config
 * surfaces as an open AGENT account and a personal (GramJS) config as an
 * owner-binding-gated OWNER account with a stable externalId, and that disabled
 * or credential-less blocks are ignored. Runtime is mocked.
 */
import type {
  ConnectorAccount,
  ConnectorAccountManager,
  IAgentRuntime,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createTelegramConnectorAccountProvider } from "./connector-account-provider";

type TelegramConfig = Record<string, unknown>;

function runtimeWith(telegram: TelegramConfig): IAgentRuntime {
  return {
    agentId: "agent-1",
    character: { name: "Agent", settings: { telegram } },
    getSetting: () => undefined,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
}

// Minimal manager whose storage returns no persisted accounts, so listAccounts
// reflects only the synthesized (config-derived) accounts under test.
function emptyManager(): ConnectorAccountManager {
  return {
    getStorage: () => ({ listAccounts: async () => [] as ConnectorAccount[] }),
  } as unknown as ConnectorAccountManager;
}

async function list(telegram: TelegramConfig): Promise<ConnectorAccount[]> {
  const provider = createTelegramConnectorAccountProvider(
    runtimeWith(telegram),
  );
  return provider.listAccounts?.(emptyManager()) ?? [];
}

describe("Telegram connector account roles (agent bot vs personal user)", () => {
  it("surfaces a bot-token account as an open AGENT account", async () => {
    const accounts = await list({ botToken: "123:abc" });
    expect(accounts).toHaveLength(1);
    const bot = accounts[0];
    expect(bot.role).toBe("AGENT");
    expect(bot.accessGate).toBe("open");
    expect(bot.metadata?.personal).toBe(false);
  });

  it("surfaces a personal account as an owner_binding-gated OWNER account with a stable externalId", async () => {
    const accounts = await list({
      accounts: {
        me: { personal: { phone: "+15551234567", enabled: true } },
      },
    });
    const owner = accounts.find((a) => a.role === "OWNER");
    expect(owner).toBeDefined();
    expect(owner?.accessGate).toBe("owner_binding");
    expect(owner?.purpose).toContain("reading");
    // Load-bearing: the owner-binding gate matches on externalId, so it must be set.
    expect(owner?.externalId).toBe("tg-user:+15551234567");
    expect(owner?.id).toBe("me:personal");
    expect(owner?.metadata?.personal).toBe(true);
  });

  it("surfaces both a bot and a personal identity from one config as two distinct accounts", async () => {
    const accounts = await list({
      accounts: {
        me: {
          botToken: "123:abc",
          personal: { phone: "+15551234567", enabled: true },
        },
      },
    });
    const bot = accounts.find((a) => a.role === "AGENT");
    const owner = accounts.find((a) => a.role === "OWNER");
    expect(bot?.id).toBe("me");
    expect(owner?.id).toBe("me:personal");
    expect(accounts).toHaveLength(2);
  });

  it("ignores a disabled or credential-less personal block", async () => {
    const disabled = await list({
      accounts: {
        me: { botToken: "1:a", personal: { phone: "+1", enabled: false } },
      },
    });
    expect(disabled.some((a) => a.role === "OWNER")).toBe(false);

    const credless = await list({
      accounts: { me: { botToken: "1:a", personal: { enabled: true } } },
    });
    expect(credless.some((a) => a.role === "OWNER")).toBe(false);
  });
});
