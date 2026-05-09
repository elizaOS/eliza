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
      fetch: async () =>
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
        ),
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.providerId).toBe("openai-codex");
    expect(writes[0]?.usage?.sessionPct).toBe(12);
  });
});
