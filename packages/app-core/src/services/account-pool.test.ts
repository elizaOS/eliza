import type { LinkedAccountConfig } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { AccountPool } from "./account-pool";

function account(
  providerId: LinkedAccountConfig["providerId"],
  overrides: Partial<LinkedAccountConfig> = {},
): LinkedAccountConfig {
  return {
    id: "shared-id",
    providerId,
    label: providerId,
    source: "oauth",
    enabled: true,
    priority: 0,
    createdAt: 1,
    health: "ok",
    ...overrides,
  };
}

describe("AccountPool provider-scoped account resolution", () => {
  it("gets the matching provider account when ids collide", () => {
    const accounts = {
      "openai-codex:shared-id": account("openai-codex"),
      "anthropic-subscription:shared-id": account("anthropic-subscription", {
        priority: 1,
      }),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async () => {},
    });

    expect(pool.get("shared-id", "anthropic-subscription")?.providerId).toBe(
      "anthropic-subscription",
    );
    expect(pool.get("shared-id", "openai-codex")?.providerId).toBe(
      "openai-codex",
    );
  });

  it("scopes health mutations to the provider when ids collide", async () => {
    const writes: LinkedAccountConfig[] = [];
    const accounts = {
      "openai-codex:shared-id": account("openai-codex"),
      "anthropic-subscription:shared-id": account("anthropic-subscription"),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async (next) => {
        writes.push(next);
      },
    });

    await pool.markInvalid("shared-id", "expired", {
      providerId: "anthropic-subscription",
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.providerId).toBe("anthropic-subscription");
    expect(writes[0]?.health).toBe("invalid");
  });

  it("runs usage probes against the provider-scoped account", async () => {
    const writes: LinkedAccountConfig[] = [];
    const accounts = {
      "anthropic-subscription:shared-id": account("anthropic-subscription"),
      "openai-codex:shared-id": account("openai-codex", {
        organizationId: "org_1",
      }),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async (next) => {
        writes.push(next);
      },
    });

    await pool.refreshUsage("shared-id", "token", {
      providerId: "openai-codex",
      codexAccountId: "org_1",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            rate_limit: {
              primary_window: {
                used_percent: 12,
                reset_at: 1_800_000_000,
              },
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.providerId).toBe("openai-codex");
    expect(writes[0]?.usage?.sessionPct).toBe(12);
  });

  it("selects among multiple accounts for the same provider by priority", async () => {
    const accounts = {
      "openai-codex:personal": account("openai-codex", {
        id: "personal",
        priority: 5,
        createdAt: 2,
      }),
      "openai-codex:work": account("openai-codex", {
        id: "work",
        priority: 1,
        createdAt: 1,
      }),
      "anthropic-subscription:work": account("anthropic-subscription", {
        id: "work",
        priority: 0,
      }),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async () => {},
    });

    await expect(pool.select({ providerId: "openai-codex" })).resolves
      .toMatchObject({
        id: "work",
        providerId: "openai-codex",
      });
  });

  it("round-robins across multiple accounts for one provider", async () => {
    const accounts = {
      "openai-codex:first": account("openai-codex", {
        id: "first",
        priority: 0,
        createdAt: 1,
      }),
      "openai-codex:second": account("openai-codex", {
        id: "second",
        priority: 1,
        createdAt: 2,
      }),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async () => {},
    });

    await expect(
      pool.select({ providerId: "openai-codex", strategy: "round-robin" }),
    ).resolves.toMatchObject({ id: "first" });
    await expect(
      pool.select({ providerId: "openai-codex", strategy: "round-robin" }),
    ).resolves.toMatchObject({ id: "second" });
    await expect(
      pool.select({ providerId: "openai-codex", strategy: "round-robin" }),
    ).resolves.toMatchObject({ id: "first" });
  });

  it("keeps session affinity across multiple accounts for one provider", async () => {
    const accounts = {
      "openai-codex:first": account("openai-codex", {
        id: "first",
        priority: 0,
        createdAt: 1,
      }),
      "openai-codex:second": account("openai-codex", {
        id: "second",
        priority: 1,
        createdAt: 2,
      }),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async () => {},
    });

    const first = await pool.select({
      providerId: "openai-codex",
      strategy: "round-robin",
      sessionKey: "agent-a",
    });
    const second = await pool.select({
      providerId: "openai-codex",
      strategy: "round-robin",
      sessionKey: "agent-a",
    });
    const otherSession = await pool.select({
      providerId: "openai-codex",
      strategy: "round-robin",
      sessionKey: "agent-b",
    });

    expect(first?.id).toBe("first");
    expect(second?.id).toBe("first");
    expect(otherSession?.id).toBe("second");
  });

  it("uses usage-aware strategies across same-provider accounts", async () => {
    const accounts = {
      "openai-codex:near-limit": account("openai-codex", {
        id: "near-limit",
        priority: 0,
        usage: { sessionPct: 95, refreshedAt: 1 },
      }),
      "openai-codex:available": account("openai-codex", {
        id: "available",
        priority: 1,
        usage: { sessionPct: 20, refreshedAt: 1 },
      }),
      "openai-codex:least-used": account("openai-codex", {
        id: "least-used",
        priority: 2,
        usage: { sessionPct: 5, refreshedAt: 1 },
      }),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async () => {},
    });

    await expect(
      pool.select({ providerId: "openai-codex", strategy: "quota-aware" }),
    ).resolves.toMatchObject({ id: "available" });
    await expect(
      pool.select({ providerId: "openai-codex", strategy: "least-used" }),
    ).resolves.toMatchObject({ id: "least-used" });
  });
});
