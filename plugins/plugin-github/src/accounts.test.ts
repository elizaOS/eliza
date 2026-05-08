import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  readGitHubAccounts,
  resolveGitHubAccount,
  resolveGitHubAccountSelection,
} from "./accounts";

function runtime(settings: Record<string, unknown>): IAgentRuntime {
  return {
    character: {},
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

describe("GitHub account resolution", () => {
  it("keeps legacy user/agent PATs as role-tagged accounts", () => {
    const accounts = readGitHubAccounts(
      runtime({
        GITHUB_USER_PAT: "user-token",
        GITHUB_AGENT_PAT: "agent-token",
      }),
    );

    expect(accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "user",
          role: "user",
          token: "user-token",
        }),
        expect.objectContaining({
          accountId: "agent",
          role: "agent",
          token: "agent-token",
        }),
      ]),
    );
  });

  it("resolves explicit accountId before role defaults", () => {
    const accounts = readGitHubAccounts(
      runtime({
        GITHUB_AGENT_PAT: "legacy-agent",
        GITHUB_ACCOUNTS: JSON.stringify({
          reviewer: { role: "user", token: "reviewer-token" },
        }),
      }),
    );
    const selection = resolveGitHubAccountSelection(
      { accountId: "reviewer", as: "agent" },
      "agent",
    );

    expect(resolveGitHubAccount(accounts, selection)).toMatchObject({
      accountId: "reviewer",
      role: "user",
      token: "reviewer-token",
    });
  });
});
