import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { resolveDefaultNostrAccountId, resolveNostrAccountSettings } from "../accounts.js";

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
