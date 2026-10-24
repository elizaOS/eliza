/** A corrupt inline service-account JSON must not be advertised as a connected account. */
import { AgentRuntime, type ConnectorAccountManager, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createGoogleChatConnectorAccountProvider } from "./connector-account-provider.ts";

const manager = {} as ConnectorAccountManager;

function runtime(settings: Record<string, string> = {}): IAgentRuntime {
  return new AgentRuntime({ character: { name: "ChatAccountProvider", settings } });
}

const VALID_SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  client_email: "bot@project.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n",
});

// Truncated mid-object: what a hand-edited character file or a partially
// written secret looks like. `createAuth` JSON.parses this string unguarded,
// so every real Chat call fails with a SyntaxError.
const CORRUPT_SERVICE_ACCOUNT = '{"type":"service_account","client_email":"bot@project.iam';

describe("Google Chat connector account status", () => {
  it("reports a corrupt inline service-account JSON as an error, not connected", async () => {
    const provider = createGoogleChatConnectorAccountProvider(
      runtime({ GOOGLE_CHAT_SERVICE_ACCOUNT: CORRUPT_SERVICE_ACCOUNT })
    );
    const accounts = await provider.listAccounts(manager);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].status).toBe("error");
    expect(accounts[0].metadata?.serviceAccountError).toBeTruthy();
  });

  it("does not copy credential bytes out of the payload into account metadata", async () => {
    // `JSON.parse` quotes a window of the input around the offending token, so
    // the raw SyntaxError message here contains a fragment of the private key.
    const unquotedPayload = '{"private_key":PRIVKEYSENTINEL_ABC123}';
    expect(() => JSON.parse(unquotedPayload)).toThrow(/PRIVKEYSEN/);

    const provider = createGoogleChatConnectorAccountProvider(
      runtime({ GOOGLE_CHAT_SERVICE_ACCOUNT: unquotedPayload })
    );
    const accounts = await provider.listAccounts(manager);

    expect(accounts[0].status).toBe("error");
    expect(accounts[0].metadata?.serviceAccountError).toBe(
      "Inline service account JSON could not be parsed"
    );
    expect(JSON.stringify(accounts[0].metadata)).not.toContain("PRIVKEYSEN");
  });

  it("still reports a parseable service account as connected with its bot identity", async () => {
    const provider = createGoogleChatConnectorAccountProvider(
      runtime({ GOOGLE_CHAT_SERVICE_ACCOUNT: VALID_SERVICE_ACCOUNT })
    );
    const accounts = await provider.listAccounts(manager);
    expect(accounts[0].status).toBe("connected");
    expect(accounts[0].externalId).toBe("bot@project.iam.gserviceaccount.com");
    expect(accounts[0].metadata?.serviceAccountError).toBeUndefined();
  });

  it("keeps the connected status when a key file supplies auth instead of inline JSON", async () => {
    const provider = createGoogleChatConnectorAccountProvider(
      runtime({
        GOOGLE_CHAT_SERVICE_ACCOUNT: CORRUPT_SERVICE_ACCOUNT,
        GOOGLE_CHAT_SERVICE_ACCOUNT_FILE: "/etc/eliza/chat-service-account.json",
      })
    );
    const accounts = await provider.listAccounts(manager);
    // `createAuth` prefers the key file, so the unused inline string cannot
    // break authentication and must not downgrade the account.
    expect(accounts[0].status).toBe("connected");
  });

  it("keeps reporting a disabled account as disabled", async () => {
    const provider = createGoogleChatConnectorAccountProvider(
      runtime({ GOOGLE_CHAT_ENABLED: "false" })
    );
    const accounts = await provider.listAccounts(manager);
    expect(accounts[0].status).toBe("disabled");
  });
});
