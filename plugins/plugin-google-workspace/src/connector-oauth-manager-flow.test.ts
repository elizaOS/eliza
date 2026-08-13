/**
 * Manager→provider regression for the #18080 fail-closed contract: drives the
 * REAL core `ConnectorAccountManager.completeOAuth` (which consumes the
 * one-time state before calling the provider) into the REAL Google provider.
 * Only Google's HTTP token response is stubbed, via a loopback server behind
 * `ELIZA_MOCK_GOOGLE_BASE`; runtime services are in-memory fakes shaped like
 * their production counterparts. Proves that when the provider throws the
 * durable-writer ElizaError, the manager persists an explicit failed flow
 * (status, error text, stable error code) instead of leaving a consumed flow
 * that reports "pending" forever, and that the pending account is never
 * patched to connected.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getConnectorAccountManager, type IAgentRuntime, isElizaError } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGoogleConnectorAccountProvider } from "./connector-account-provider.js";
import { CONNECTOR_CREDENTIAL_WRITER_UNAVAILABLE_CODE } from "./connector-credential-refs.js";

const AGENT_ID = "6f110aa9-c169-0e10-8a4f-b4cca439be25";

function unsignedJwt(payload: Record<string, unknown>): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.`;
}

let tokenServer: http.Server;
let previousMockBase: string | undefined;

beforeAll(async () => {
  tokenServer = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/token") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.readonly",
          id_token: unsignedJwt({
            sub: "google-sub-1",
            email: "owner@example.com",
            email_verified: true,
            name: "Owner",
          }),
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
  previousMockBase = process.env.ELIZA_MOCK_GOOGLE_BASE;
  const { port } = tokenServer.address() as AddressInfo;
  process.env.ELIZA_MOCK_GOOGLE_BASE = `http://127.0.0.1:${port}/`;
});

afterAll(async () => {
  if (previousMockBase === undefined) delete process.env.ELIZA_MOCK_GOOGLE_BASE;
  else process.env.ELIZA_MOCK_GOOGLE_BASE = previousMockBase;
  await new Promise<void>((resolve, reject) =>
    tokenServer.close((err) => (err ? reject(err) : resolve()))
  );
});

function createRuntime(settings: Record<string, string>): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    getService: () => null,
    getRegisteredServiceTypes: () => [],
    getSetting: (key: string) =>
      key === "GOOGLE_CLIENT_ID"
        ? "client-id"
        : key === "GOOGLE_CLIENT_SECRET"
          ? "client-secret"
          : key === "GOOGLE_REDIRECT_URI"
            ? "http://127.0.0.1:2138/api/connectors/google/oauth/callback"
            : settings[key],
    getMessageConnectors: () => [],
    getPostConnectors: () => [],
    registerMessageConnector: () => undefined,
    registerPostConnector: () => undefined,
  } as unknown as IAgentRuntime;
}

describe("real manager → real Google provider fail-closed flow (#18080)", () => {
  it("persists an explicit failed flow with the provider's typed error when the durable-writer check throws after the state is consumed", async () => {
    // Cloud-provisioned topology: no durable writer anywhere → fail closed.
    const runtime = createRuntime({ ELIZA_CLOUD_PROVISIONED: "1" });
    const manager = getConnectorAccountManager(runtime);
    manager.registerProvider(createGoogleConnectorAccountProvider(runtime));

    // The connect UI pre-creates the account row and starts OAuth against it,
    // exactly like POST /accounts then POST /oauth/start.
    const created = await manager.createAccount("google", { status: "pending" });
    const flow = await manager.startOAuth("google", {
      accountId: created.id,
      scopes: ["gmail.read"],
    });
    expect(flow.status).toBe("pending");

    // First callback: real code exchange (loopback-stubbed response), real
    // pending-account upsert, then the durable-writer rejection.
    const attempt = manager.completeOAuth("google", {
      state: flow.state,
      code: "test-auth-code",
    });
    await expect(attempt).rejects.toThrow(/No durable connector credential store or vault writer/);
    const err = await attempt.catch((e) => e);
    expect(isElizaError(err)).toBe(true);
    expect(err.code).toBe(CONNECTOR_CREDENTIAL_WRITER_UNAVAILABLE_CODE);

    // The consumed flow is now terminally failed — actionable, not "pending".
    const failed = await manager.getOAuthFlow("google", flow.state);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/No durable connector credential store/);
    expect(failed?.metadata?.errorCode).toBe(CONNECTOR_CREDENTIAL_WRITER_UNAVAILABLE_CODE);

    // The account created mid-completion stays pending; no credential ref was
    // recorded, so nothing dangles after a restart.
    const accounts = await manager.getStorage().listAccounts("google");
    expect(accounts).toHaveLength(1);
    expect(accounts[0].status).toBe("pending");
    expect(accounts[0].metadata?.credentialRefs).toBeUndefined();

    // A second callback still reports the consumed state — but the flow record
    // above now explains why, instead of claiming the flow is pending.
    await expect(
      manager.completeOAuth("google", { state: flow.state, code: "test-auth-code" })
    ).rejects.toThrow(/Unknown, expired, or already used OAuth flow state/);
  });
});
