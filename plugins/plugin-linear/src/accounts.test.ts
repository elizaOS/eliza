import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { readLinearAccounts, resolveLinearAccount, resolveLinearAccountId } from "./accounts";

function runtime(settings: Record<string, unknown>): IAgentRuntime {
  return {
    character: {},
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

describe("Linear account resolution", () => {
  it("keeps the legacy LINEAR_API_KEY as the default account", () => {
    const rt = runtime({
      LINEAR_API_KEY: "linear-key",
      LINEAR_WORKSPACE_ID: "workspace",
    });

    expect(readLinearAccounts(rt)).toEqual([
      expect.objectContaining({
        accountId: "default",
        apiKey: "linear-key",
        workspaceId: "workspace",
      }),
    ]);
    expect(resolveLinearAccountId(rt)).toBe("default");
  });

  it("resolves a configured accountId before falling back to default", () => {
    const rt = runtime({
      LINEAR_ACCOUNTS: JSON.stringify({
        personal: { apiKey: "personal-key" },
        work: { apiKey: "work-key", workspaceId: "workspace" },
      }),
    });
    const accounts = readLinearAccounts(rt);

    expect(resolveLinearAccountId(rt, { accountId: "work" })).toBe("work");
    expect(resolveLinearAccount(accounts, "work")).toMatchObject({
      accountId: "work",
      apiKey: "work-key",
    });
  });
});
