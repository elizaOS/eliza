/**
 * Unit tests for the multi-account resolution helpers in `accounts.ts` —
 * role normalization and the env-vs-config account resolution/role wiring.
 * Uses a hand-built fake runtime; no live Slack API.
 */
import {
  type Character,
  connectorAccountCredentialSettingKey,
  connectorBaseCredentialSettingKey,
  type IAgentRuntime,
} from "@elizaos/core";
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
  privateCredentials?: Record<string, unknown>,
): IAgentRuntime {
  const credentialSecrets: Record<string, string> = {};
  for (const [field, value] of Object.entries(privateCredentials ?? {})) {
    if (field === "accounts" || typeof value !== "string") continue;
    credentialSecrets[connectorBaseCredentialSettingKey("slack", field)] =
      value;
  }
  const accounts = privateCredentials?.accounts;
  if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) {
    for (const [accountId, rawAccount] of Object.entries(accounts)) {
      if (!rawAccount || typeof rawAccount !== "object") continue;
      for (const [field, value] of Object.entries(rawAccount)) {
        if (typeof value !== "string") continue;
        credentialSecrets[
          connectorAccountCredentialSettingKey("slack", accountId, field)
        ] = value;
      }
    }
  }
  const character: Partial<Character> = {
    settings: slackConfig ? { slack: slackConfig } : {},
    secrets: credentialSecrets,
  };
  const env = envOverrides ?? {};
  const runtime = {
    agentId: "agent-1",
    character: character as Character,
    getSetting: vi.fn(
      (key: string) => character.secrets?.[key] ?? env[key] ?? null,
    ),
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
  it("combines public policy with private per-account credentials", () => {
    const runtime = createRuntime(
      {
        accounts: {
          support: {
            role: "OWNER",
            groupPolicy: "allowlist",
            channels: { support: { enabled: true } },
          },
        },
      },
      undefined,
      {
        accounts: {
          support: {
            botToken: "xoxb-private",
            appToken: "xapp-private",
            userToken: "xoxp-private",
            signingSecret: "signing-private",
          },
        },
      },
    );

    const account = resolveSlackAccount(runtime, "support");
    expect(account).toMatchObject({
      role: "OWNER",
      botToken: "xoxb-private",
      appToken: "xapp-private",
      userToken: "xoxp-private",
      signingSecret: "signing-private",
      channels: { support: { enabled: true } },
    });
  });

  it("does not consume the retired packed credential setting", () => {
    const runtime = createRuntime(undefined, {
      SLACK_CONNECTOR_CREDENTIALS_JSON: JSON.stringify({
        groupPolicy: "open",
      }),
    });
    expect(resolveSlackAccount(runtime).config.groupPolicy).toBeUndefined();
  });

  it("normalizes configured account IDs", () => {
    const runtime = createRuntime({
      accounts: {
        " Owner ": {
          botToken: "xoxb-owner",
          appToken: "xapp-owner",
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

  it("rejects account identifiers that collide after normalization", () => {
    const runtime = createRuntime({
      accounts: {
        " Owner ": { botToken: "xoxb-owner", appToken: "xapp-owner" },
        owner: { botToken: "xoxb-owner-2", appToken: "xapp-owner-2" },
      },
    });

    expect(() => listSlackAccountIds(runtime)).toThrowError(
      expect.objectContaining({ code: "SLACK_ACCOUNT_ID_COLLISION" }),
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

describe("resolveSlackAccount ghost accountId fail-closed", () => {
  it("does not inherit owner settings tokens for an explicit ghost accountId", () => {
    const runtime = createRuntime({
      botToken: "xoxb-owner",
      appToken: "xapp-owner",
      userToken: "xoxp-owner",
      signingSecret: "sign-owner",
    });

    const ghost = resolveSlackAccount(runtime, "ghost-account");
    expect(ghost.accountId).toBe("ghost-account");
    expect(ghost.botToken).toBeUndefined();
    expect(ghost.appToken).toBeUndefined();
    expect(ghost.userToken).toBeUndefined();
    expect(ghost.signingSecret).toBeUndefined();
  });

  it("still binds omitted accountId to the default owner tokens", () => {
    const runtime = createRuntime({
      botToken: "xoxb-owner",
      appToken: "xapp-owner",
      userToken: "xoxp-owner",
      signingSecret: "sign-owner",
    });

    const omitted = resolveSlackAccount(runtime);
    expect(omitted.accountId).toBe("default");
    expect(omitted.botToken).toBe("xoxb-owner");
    expect(omitted.appToken).toBe("xapp-owner");
    expect(omitted.userToken).toBe("xoxp-owner");
    expect(omitted.signingSecret).toBe("sign-owner");
  });

  it("does not inherit env signing secret for a ghost accountId", () => {
    const runtime = createRuntime(undefined, {
      SLACK_BOT_TOKEN: "xoxb-env",
      SLACK_APP_TOKEN: "xapp-env",
      SLACK_USER_TOKEN: "xoxp-env",
      SLACK_SIGNING_SECRET: "sign-env",
    });

    const ghost = resolveSlackAccount(runtime, "ghost-account");
    expect(ghost.botToken).toBeUndefined();
    expect(ghost.appToken).toBeUndefined();
    expect(ghost.userToken).toBeUndefined();
    expect(ghost.signingSecret).toBeUndefined();

    const def = resolveSlackAccount(runtime);
    expect(def.accountId).toBe("default");
    expect(def.botToken).toBe("xoxb-env");
    expect(def.signingSecret).toBe("sign-env");
  });

  it("does not inherit base vault tokens for a ghost accountId", () => {
    const runtime = createRuntime(undefined, undefined, {
      botToken: "xoxb-vault",
      appToken: "xapp-vault",
      userToken: "xoxp-vault",
      signingSecret: "sign-vault",
    });

    const ghost = resolveSlackAccount(runtime, "ghost-account");
    expect(ghost.botToken).toBeUndefined();
    expect(ghost.appToken).toBeUndefined();
    expect(ghost.userToken).toBeUndefined();
    expect(ghost.signingSecret).toBeUndefined();

    const def = resolveSlackAccount(runtime);
    expect(def.accountId).toBe("default");
    expect(def.botToken).toBe("xoxb-vault");
    expect(def.appToken).toBe("xapp-vault");
  });
});
