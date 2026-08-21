/**
 * Unit tests for Google Chat multi-account resolution, the connector account
 * provider against an in-memory `getSetting` stub — no Google API calls.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  listGoogleChatAccountIds,
  readGoogleChatAccountId,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccountSettings,
} from "./accounts.js";
import { createGoogleChatConnectorAccountProvider } from "./connector-account-provider.js";

function runtime(
  settings: Record<string, unknown> = {},
  characterSettings: Record<string, unknown> = {}
): IAgentRuntime {
  return {
    character: { settings: characterSettings },
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  } as unknown as IAgentRuntime;
}

describe("Google Chat account config", () => {
  it("does not fabricate a default account when Google Chat is unconfigured", () => {
    const rt = runtime();

    expect(listGoogleChatAccountIds(rt)).toEqual([]);
    expect(resolveDefaultGoogleChatAccountId(rt)).toBe("default");
  });

  it("keeps an explicitly enabled but incomplete default account visible for validation", () => {
    const rt = runtime({ GOOGLE_CHAT_ENABLED: "true" });

    expect(listGoogleChatAccountIds(rt)).toEqual(["default"]);
  });

  it("fails closed for malformed GOOGLE_CHAT_ACCOUNTS", () => {
    const rt = runtime({
      GOOGLE_CHAT_ACCOUNTS: "{not json",
    });

    expect(() => listGoogleChatAccountIds(rt)).toThrow(ElizaError);
    try {
      resolveDefaultGoogleChatAccountId(rt);
      throw new Error("expected malformed GOOGLE_CHAT_ACCOUNTS to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe("GOOGLE_CHAT_CONFIG_INVALID");
      expect((error as ElizaError).context).toEqual({ setting: "GOOGLE_CHAT_ACCOUNTS" });
      expect((error as ElizaError).severity).toBe("fatal");
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    }
  });

  it("does not leak default env credentials into explicitly requested named accounts", () => {
    const rt = runtime({
      GOOGLE_CHAT_SERVICE_ACCOUNT: '{"client_email":"default@example.com"}',
      GOOGLE_CHAT_AUDIENCE: "https://default.example.com/googlechat",
      GOOGLE_CHAT_ACCOUNTS: JSON.stringify({
        partner: {
          audience: "https://partner.example.com/googlechat",
          spaces: " spaces/AAA, ,spaces/BBB ",
          enabled: false,
        },
      }),
    });

    expect(resolveGoogleChatAccountSettings(rt, "partner")).toMatchObject({
      accountId: "partner",
      serviceAccount: undefined,
      serviceAccountFile: undefined,
      audience: "https://partner.example.com/googlechat",
      spaces: ["spaces/AAA", "spaces/BBB"],
      enabled: false,
    });
  });

  it("reads account IDs from nested connector payloads in priority order", () => {
    expect(
      readGoogleChatAccountId(
        { metadata: { accountId: "metadata" } },
        { data: { googleChat: { accountId: "nested" } } }
      )
    ).toBe("metadata");
    expect(readGoogleChatAccountId({ data: { googleChat: { accountId: " partner " } } })).toBe(
      "partner"
    );
    expect(readGoogleChatAccountId({ accountId: " " })).toBeUndefined();
  });

  it("lists disabled connector accounts instead of reporting them connected", async () => {
    const provider = createGoogleChatConnectorAccountProvider(
      runtime(
        {},
        {
          googleChat: {
            accounts: {
              partner: {
                enabled: false,
                serviceAccount: '{"client_email":"partner@example.com"}',
                audience: "https://partner.example.com/googlechat",
              },
            },
          },
        }
      )
    );

    await expect(provider.listAccounts({} as never)).resolves.toMatchObject([
      {
        id: "partner",
        provider: "google-chat",
        status: "disabled",
        externalId: "partner@example.com",
      },
    ]);
  });
});

describe("resolveGoogleChatAccountSettings owner-bind fail-closed", () => {
  const ownerCharacter = {
    googleChat: {
      serviceAccount: '{"client_email":"owner@example.com"}',
      serviceAccountFile: "/owner/sa.json",
      audience: "https://owner.example.com/googlechat",
      spaces: ["spaces/OWNER"],
    },
  };
  const ownerEnv = {
    GOOGLE_CHAT_SERVICE_ACCOUNT: '{"client_email":"env@example.com"}',
    GOOGLE_CHAT_SERVICE_ACCOUNT_FILE: "/env/sa.json",
    GOOGLE_CHAT_AUDIENCE: "https://env.example.com/googlechat",
  };

  it("lets the default account inherit owner character service-account credentials", () => {
    const rt = runtime({}, ownerCharacter);
    const resolved = resolveGoogleChatAccountSettings(rt, "default");
    expect(resolved.accountId).toBe("default");
    expect(resolved.serviceAccount).toBe('{"client_email":"owner@example.com"}');
    expect(resolved.serviceAccountFile).toBe("/owner/sa.json");
  });

  it("does not give a ghost accountId the owner service-account JSON or key file", () => {
    const rt = runtime({}, ownerCharacter);
    const ghost = resolveGoogleChatAccountSettings(rt, "ghost-account");
    expect(ghost.accountId).toBe("ghost-account");
    expect(ghost.serviceAccount).toBeUndefined();
    expect(ghost.serviceAccountFile).toBeUndefined();
  });

  it("does not let a named account without its own credentials inherit character tokens", () => {
    const rt = runtime(
      {},
      {
        googleChat: {
          ...ownerCharacter.googleChat,
          accounts: {
            partner: { enabled: true, audience: "https://partner.example.com/googlechat" },
          },
        },
      }
    );
    const partner = resolveGoogleChatAccountSettings(rt, "partner");
    expect(partner.accountId).toBe("partner");
    expect(partner.serviceAccount).toBeUndefined();
    expect(partner.serviceAccountFile).toBeUndefined();
    expect(partner.audience).toBe("https://partner.example.com/googlechat");
  });

  it("keeps a named account own credentials and does not attach owner character secrets", () => {
    const rt = runtime(
      {},
      {
        googleChat: {
          ...ownerCharacter.googleChat,
          accounts: {
            partner: {
              serviceAccount: '{"client_email":"partner@example.com"}',
              serviceAccountFile: "/partner/sa.json",
              audience: "https://partner.example.com/googlechat",
            },
          },
        },
      }
    );
    const partner = resolveGoogleChatAccountSettings(rt, "partner");
    expect(partner.serviceAccount).toBe('{"client_email":"partner@example.com"}');
    expect(partner.serviceAccountFile).toBe("/partner/sa.json");
  });

  it("does not give a ghost accountId owner env credentials either", () => {
    const rt = runtime(ownerEnv);
    const ghost = resolveGoogleChatAccountSettings(rt, "ghost-account");
    expect(ghost.serviceAccount).toBeUndefined();
    expect(ghost.serviceAccountFile).toBeUndefined();
    const def = resolveGoogleChatAccountSettings(rt, "default");
    expect(def.serviceAccount).toBe('{"client_email":"env@example.com"}');
    expect(def.serviceAccountFile).toBe("/env/sa.json");
  });

  it("binds application-default credentials only to the default account", () => {
    const previous = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/owner/application-default.json";
    try {
      const rt = runtime();
      expect(resolveGoogleChatAccountSettings(rt, "default").serviceAccountFile).toBe(
        "/owner/application-default.json"
      );
      expect(
        resolveGoogleChatAccountSettings(rt, "ghost-account").serviceAccountFile
      ).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = previous;
    }
  });

  it("fails closed when readGoogleChatAccountId supplies a ghost id from request metadata", () => {
    const rt = runtime({}, ownerCharacter);
    const accountId = readGoogleChatAccountId({ metadata: { accountId: "ghost-account" } });
    expect(accountId).toBe("ghost-account");
    const ghost = resolveGoogleChatAccountSettings(rt, accountId);
    expect(ghost.serviceAccount).toBeUndefined();
    expect(ghost.serviceAccountFile).toBeUndefined();
  });
});
