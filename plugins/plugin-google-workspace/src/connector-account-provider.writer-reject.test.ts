/**
 * The #18080 store-failure contract at the real manager→provider boundary:
 * a registered durable credential store whose `putSecret()` rejects must not
 * leave the consumed OAuth flow stranded as `pending`. Drives the REAL
 * `ConnectorAccountManager` (core) and the REAL Google connector provider;
 * only the Google token-endpoint HTTP response is stubbed (a successful
 * exchange, so the failure under test is the writer, not the provider).
 * First completion surfaces the writer failure and persists a terminal
 * `failed` flow with a typed error; the same state cannot be replayed.
 */
import {
  type ConnectorAccountManager,
  ElizaError,
  getConnectorAccountManager,
  type IAgentRuntime,
  InMemoryDatabaseAdapter,
} from "@elizaos/core";
import { OAuth2Client } from "google-auth-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleConnectorAccountProvider } from "./connector-account-provider.js";

const REDIRECT_URI = "http://127.0.0.1:31437/api/connectors/google/oauth/callback";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const WRITER_ERROR = "PGlite vault writer lock is held by another process";

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function makeRuntime(
  putSecret: (params: unknown) => Promise<string>,
  adapter: InMemoryDatabaseAdapter
): IAgentRuntime {
  const messageConnectors: unknown[] = [];
  const postConnectors: unknown[] = [];
  return {
    agentId: "00000000-0000-4000-8000-00000000e19a",
    // Real durable adapter: OAuth flow state and credential-ref rows go
    // through the same storage contract the deployed SQL adapter implements.
    adapter,
    getSetting: (key: string) =>
      ({
        GOOGLE_CLIENT_ID: "writer-reject-client",
        GOOGLE_CLIENT_SECRET: "writer-reject-secret",
        GOOGLE_REDIRECT_URI: REDIRECT_URI,
      })[key],
    // The durable credential store is the ONLY registered writer: no `vault`
    // service exists to silently absorb the write, exactly the deployment
    // shape #18080 covers.
    getService: (name: string) => (name === "connector_credential_store" ? { putSecret } : null),
    getMessageConnectors: () => messageConnectors,
    registerMessageConnector: (connector: unknown) => {
      messageConnectors.push(connector);
    },
    getPostConnectors: () => postConnectors,
    registerPostConnector: (connector: unknown) => {
      postConnectors.push(connector);
    },
  } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubTokenExchangeSuccess(nonce: string): ReturnType<typeof vi.fn> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "https://accounts.google.com",
    aud: "writer-reject-client",
    iat: now - 10,
    exp: now + 3600,
    sub: "google-sub-writer-reject",
    email: "writer-reject@example.com",
    email_verified: true,
    nonce,
  };
  vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
    getPayload: () => payload,
  } as never);
  const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url !== TOKEN_ENDPOINT) {
      throw new Error(`unexpected network call in writer-reject test: ${url}`);
    }
    return {
      ok: true,
      json: async () => ({
        access_token: "writer-reject-access-token",
        refresh_token: "writer-reject-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        id_token: `${b64url({ alg: "RS256", kid: "test-key" })}.${b64url(payload)}.sig`,
      }),
    };
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

describe("google provider completion with a rejecting durable credential writer (#18080 / #19225)", () => {
  it("persists a terminal failed flow, surfaces the writer error typed, and keeps the state consumed", async () => {
    const putSecret = vi.fn(async () => {
      throw new Error(WRITER_ERROR);
    });
    const adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
    const runtime = makeRuntime(putSecret, adapter);
    const manager: ConnectorAccountManager = getConnectorAccountManager(runtime);
    manager.registerProvider(createGoogleConnectorAccountProvider(runtime));
    const flow = await manager.startOAuth("google", {
      scopes: ["gmail.read"],
      metadata: { requestedRole: "OWNER" },
    });
    const fetchStub = stubTokenExchangeSuccess(
      String((flow.metadata as Record<string, unknown>).oidcNonce)
    );

    // First completion: token exchange succeeds, the durable write rejects,
    // and the callback surfaces the writer failure as a typed error.
    let thrown: unknown;
    try {
      await manager.completeOAuth("google", { state: flow.state, code: "auth-code-1" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ElizaError);
    const typed = thrown as ElizaError;
    expect(typed.code).toBe("CONNECTOR_OAUTH_COMPLETION_FAILED");
    // The public message is generic; the raw writer failure rides the cause.
    expect(typed.message).not.toContain(WRITER_ERROR);
    expect((typed.cause as Error).message).toContain(WRITER_ERROR);
    expect(typed.context).toMatchObject({ provider: "google", flowId: flow.id });
    expect(putSecret).toHaveBeenCalledOnce();
    expect(fetchStub).toHaveBeenCalledOnce();

    // The stored flow is terminal `failed` with a generic public message —
    // not `pending` with no error, and not the raw writer exception text.
    const stored = await manager.getOAuthFlow("google", flow.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).not.toContain(WRITER_ERROR);
    expect(stored?.error).toMatch(/start the flow again/i);

    // The one-time state was consumed by the first attempt and cannot be
    // replayed against the already-failed flow.
    await expect(
      manager.completeOAuth("google", { state: flow.state, code: "auth-code-2" })
    ).rejects.toThrow(/already used|unknown|expired/i);
  });
});
