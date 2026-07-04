/**
 * Unit tests for Google Chat multi-account resolution, the connector account
 * provider, and the workflow credential provider, against an in-memory
 * `getSetting` stub — no Google API calls.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  listGoogleChatAccountIds,
  readGoogleChatAccountId,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccountSettings,
} from "./accounts.js";
import { createGoogleChatConnectorAccountProvider } from "./connector-account-provider.js";
import { GoogleChatWorkflowCredentialProvider } from "./workflow-credential-provider.js";

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
  it("ignores malformed GOOGLE_CHAT_ACCOUNTS and falls back to default discovery", () => {
    const rt = runtime({
      GOOGLE_CHAT_ACCOUNTS: "{not json",
    });

    expect(listGoogleChatAccountIds(rt)).toEqual(["default"]);
    expect(resolveDefaultGoogleChatAccountId(rt)).toBe("default");
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

describe("GoogleChatWorkflowCredentialProvider", () => {
  it("returns trimmed inline service-account JSON for supported workflow credentials", async () => {
    const provider = new GoogleChatWorkflowCredentialProvider(
      runtime({
        GOOGLE_CHAT_SERVICE_ACCOUNT: '  {"client_email":"bot@example.com"}  ',
      })
    );

    await expect(provider.resolve("user-1", "googleChatOAuth2Api")).resolves.toEqual({
      status: "credential_data",
      data: {
        serviceAccountKey: '{"client_email":"bot@example.com"}',
      },
    });
    expect(provider.checkCredentialTypes(["googleChatOAuth2Api", "apiKeyAuth"])).toEqual({
      supported: ["googleChatOAuth2Api"],
      unsupported: ["apiKeyAuth"],
    });
  });

  it("fails closed for malformed inline credentials and unsupported types", async () => {
    const provider = new GoogleChatWorkflowCredentialProvider(
      runtime({
        GOOGLE_CHAT_SERVICE_ACCOUNT: "{not json",
      })
    );

    await expect(provider.resolve("user-1", "apiKeyAuth")).resolves.toBeNull();
    await expect(provider.resolve("user-1", "googleChatOAuth2Api")).resolves.toBeNull();
  });
});
