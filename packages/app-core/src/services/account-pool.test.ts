import type { LinkedAccountConfig } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { AccountPool } from "./account-pool";

function account(
  providerId: LinkedAccountConfig["providerId"],
  overrides: Partial<LinkedAccountConfig> = {},
): LinkedAccountConfig {
  return {
    id: "duplicate-id",
    providerId,
    label: `${providerId} account`,
    source: "oauth",
    enabled: true,
    priority: 0,
    createdAt: 1,
    health: "ok",
    ...overrides,
  };
}

describe("AccountPool provider-scoped lookup", () => {
  it("gets the account for the requested provider when ids collide", () => {
    const anthropic = account("anthropic-subscription", {
      label: "Anthropic",
    });
    const codex = account("openai-codex", {
      label: "Codex",
    });
    const pool = new AccountPool({
      readAccounts: () => ({
        "anthropic-subscription:duplicate-id": anthropic,
        "openai-codex:duplicate-id": codex,
      }),
      writeAccount: async () => {},
    });

    expect(pool.get("duplicate-id", "openai-codex")).toBe(codex);
    expect(pool.get("duplicate-id", "anthropic-subscription")).toBe(anthropic);
  });

  it("updates the provider-scoped account when marking health", async () => {
    const writes: LinkedAccountConfig[] = [];
    const anthropic = account("anthropic-subscription");
    const codex = account("openai-codex");
    const pool = new AccountPool({
      readAccounts: () => ({
        "anthropic-subscription:duplicate-id": anthropic,
        "openai-codex:duplicate-id": codex,
      }),
      writeAccount: async (next) => {
        writes.push(next);
      },
    });

    await pool.markInvalid("duplicate-id", "bad token", "openai-codex");

    expect(writes).toHaveLength(1);
    expect(writes[0]?.providerId).toBe("openai-codex");
    expect(writes[0]?.health).toBe("invalid");
    expect(writes[0]?.healthDetail?.lastError).toBe("bad token");
  });
});
