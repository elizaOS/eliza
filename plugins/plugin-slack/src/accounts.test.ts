import type { Character, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  listSlackAccountIds,
  normalizeSlackAccountRole,
  resolveSlackAccount,
  type SlackMultiAccountConfig,
} from "./accounts";

function createRuntime(
  slackConfig?: SlackMultiAccountConfig,
  envOverrides?: Record<string, string | undefined>,
): IAgentRuntime {
  const character: Partial<Character> = {
    settings: slackConfig ? { slack: slackConfig } : {},
  };
  const env = envOverrides ?? {};
  const runtime = {
    agentId: "agent-1",
    character: character as Character,
    getSetting: vi.fn((key: string) => env[key]),
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return runtime as unknown as IAgentRuntime;
}

describe("normalizeSlackAccountRole", () => {
  it("returns canonical OWNER / AGENT / TEAM for matching inputs", () => {
    expect(normalizeSlackAccountRole("OWNER")).toBe("OWNER");
    expect(normalizeSlackAccountRole("AGENT")).toBe("AGENT");
    expect(normalizeSlackAccountRole("TEAM")).toBe("TEAM");
  });

  it("uppercases mixed-case input", () => {
    expect(normalizeSlackAccountRole("owner")).toBe("OWNER");
    expect(normalizeSlackAccountRole("Agent")).toBe("AGENT");
    expect(normalizeSlackAccountRole(" team ")).toBe("TEAM");
  });

  it("falls back to AGENT for unknown / non-string values", () => {
    expect(normalizeSlackAccountRole(undefined)).toBe("AGENT");
    expect(normalizeSlackAccountRole(null)).toBe("AGENT");
    expect(normalizeSlackAccountRole("")).toBe("AGENT");
    expect(normalizeSlackAccountRole("admin")).toBe("AGENT");
    expect(normalizeSlackAccountRole(42)).toBe("AGENT");
    expect(normalizeSlackAccountRole({ role: "OWNER" })).toBe("AGENT");
  });
});

describe("resolveSlackAccount role wiring", () => {
  it("normalizes and deduplicates configured account IDs", () => {
    const runtime = createRuntime({
      accounts: {
        " Owner ": {
          botToken: "xoxb-owner",
          appToken: "xapp-owner",
        },
        owner: {
          botToken: "xoxb-owner-2",
          appToken: "xapp-owner-2",
        },
        TEAM: {
          botToken: "xoxb-team",
          appToken: "xapp-team",
        },
      },
    });

    expect(listSlackAccountIds(runtime)).toEqual(["owner", "team"]);
    expect(resolveSlackAccount(runtime, " Owner ").accountId).toBe("owner");

    const whitespaceOnly = createRuntime({
      accounts: {
        " TEAM ": {
          botToken: "xoxb-team",
          appToken: "xapp-team",
        },
      },
    });
    expect(resolveSlackAccount(whitespaceOnly, "team").botToken).toBe(
      "xoxb-team",
    );
  });

  it("defaults role to AGENT when no role is configured", () => {
    const runtime = createRuntime({
      botToken: "xoxb-bot",
      appToken: "xapp-app",
    });
    const account = resolveSlackAccount(runtime, "default");
    expect(account.role).toBe("AGENT");
  });

  it("reads role from per-account character.settings.slack.accounts entry", () => {
    const runtime = createRuntime({
      accounts: {
        owner: {
          role: "OWNER",
          botToken: "xoxb-bot",
          appToken: "xapp-app",
          userToken: "xoxp-user",
        },
      },
    });
    const account = resolveSlackAccount(runtime, "owner");
    expect(account.role).toBe("OWNER");
    expect(account.userToken).toBe("xoxp-user");
  });

  it("reads role from SLACK_ACCOUNT_ROLE env for the default account only", () => {
    const runtime = createRuntime(
      { botToken: "xoxb-bot", appToken: "xapp-app" },
      { SLACK_ACCOUNT_ROLE: "OWNER" },
    );
    const account = resolveSlackAccount(runtime, "default");
    expect(account.role).toBe("OWNER");
  });

  it("does not apply env SLACK_ACCOUNT_ROLE to non-default accounts", () => {
    const runtime = createRuntime(
      {
        accounts: {
          owner: {
            botToken: "xoxb-bot",
            appToken: "xapp-app",
          },
        },
      },
      { SLACK_ACCOUNT_ROLE: "OWNER" },
    );
    const account = resolveSlackAccount(runtime, "owner");
    // env override only applies to the legacy/default account path, so the
    // explicit per-account config (no role set) still falls back to AGENT
    expect(account.role).toBe("AGENT");
  });

  it("config role wins over env role", () => {
    const runtime = createRuntime(
      {
        botToken: "xoxb-bot",
        appToken: "xapp-app",
        accounts: {
          default: { role: "OWNER" },
        },
      },
      { SLACK_ACCOUNT_ROLE: "AGENT" },
    );
    const account = resolveSlackAccount(runtime, "default");
    expect(account.role).toBe("OWNER");
  });
});
