/**
 * Verifies Plaid HTTP routes enforce the authenticated organization boundary
 * and reject retired client-supplied access-token payloads.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "00000000-0000-4000-8000-000000000002",
  organization_id: ORGANIZATION_ID,
}));
const exchange = mock(async () => ({
  connectionId: CONNECTION_ID,
  environment: "sandbox" as const,
  institution: {
    institutionId: "ins-1",
    institutionName: "Test Bank",
    primaryAccountMask: "1234",
    accounts: [],
  },
}));
const sync = mock(async () => ({
  added: [],
  modified: [],
  removed: [],
  nextCursor: "cursor-2",
  hasMore: false,
}));
const revoke = mock(async () => ({ revoked: true as const }));
const createUpdateLinkToken = mock(async () => ({
  linkToken: "update-link-token",
  expiration: "2026-08-22T00:00:00.000Z",
  environment: "sandbox" as const,
}));
const status = mock(async () => ({
  connectionId: CONNECTION_ID,
  itemId: "item-1",
  institutionId: "ins-1",
  error: null,
  consentExpirationTime: null,
  institution: {
    institutionId: "ins-1",
    institutionName: "Test Bank",
    primaryAccountMask: "1234",
    accounts: [],
  },
}));
const resolveItem = mock(async () => ({ connectionId: CONNECTION_ID }));
const createPlaidLinkToken = mock(async () => ({
  linkToken: "new-link-token",
  expiration: "2026-08-22T00:00:00.000Z",
  environment: "sandbox" as const,
}));
const getPlaidWebhookVerificationKey = mock(async () => ({
  alg: "ES256" as const,
  crv: "P-256" as const,
  kid: "kid-1",
  kty: "EC" as const,
  use: "sig" as const,
  x: "x-coordinate",
  y: "y-coordinate",
}));

class PlaidConnectionError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

class AgentPlaidConnectorError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/plaid-connections", () => ({
  PlaidConnectionError,
  plaidConnectionService: {
    createUpdateLinkToken,
    exchange,
    resolveItem,
    revoke,
    status,
    sync,
  },
}));
mock.module("@/lib/services/agent-plaid-connector", () => ({
  AgentPlaidConnectorError,
  createPlaidLinkToken,
  getPlaidWebhookVerificationKey,
}));

const [
  { default: exchangeRoute },
  { default: syncRoute },
  { default: revokeRoute },
  { default: linkTokenRoute },
  { default: itemStatusRoute },
  { default: itemConnectionRoute },
  { default: verificationKeyRoute },
] = await Promise.all([
  import("./exchange/route"),
  import("./sync/route"),
  import("./revoke/route"),
  import("./link-token/route"),
  import("./item-status/route"),
  import("./item-connection/route"),
  import("./verification-key/route"),
]);

describe("Plaid credential-opaque routes", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    exchange.mockClear();
    sync.mockClear();
    revoke.mockClear();
    createUpdateLinkToken.mockClear();
    status.mockClear();
    resolveItem.mockClear();
    createPlaidLinkToken.mockClear();
    getPlaidWebhookVerificationKey.mockClear();
  });

  test("exchange returns no Item credential and passes authenticated org scope", async () => {
    const response = await exchangeRoute.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicToken: "public-token" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ connectionId: CONNECTION_ID });
    expect(JSON.stringify(body)).not.toContain("accessToken");
    expect(exchange).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      publicToken: "public-token",
    });
  });

  test("sync rejects access-token fields even alongside a valid connection id", async () => {
    const response = await syncRoute.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        accessToken: "retired-client-token",
      }),
    });
    expect(response.status).toBe(400);
    expect(sync).not.toHaveBeenCalled();
  });

  test("rejects malformed JSON explicitly without invoking Plaid", async () => {
    for (const route of [
      exchangeRoute,
      syncRoute,
      revokeRoute,
      linkTokenRoute,
      itemStatusRoute,
      itemConnectionRoute,
      verificationKeyRoute,
    ]) {
      const response = await route.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid JSON body.",
      });
    }
    expect(exchange).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(createUpdateLinkToken).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(resolveItem).not.toHaveBeenCalled();
    expect(getPlaidWebhookVerificationKey).not.toHaveBeenCalled();
  });

  test("scopes update, status, and webhook Item resolution to the authenticated org", async () => {
    const updateResponse = await linkTokenRoute.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        webhookUrl: "https://agent.example/plaid/webhook",
      }),
    });
    expect(updateResponse.status).toBe(200);
    expect(createUpdateLinkToken).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      userId: "00000000-0000-4000-8000-000000000002",
      connectionId: CONNECTION_ID,
      webhookUrl: "https://agent.example/plaid/webhook",
    });

    const statusResponse = await itemStatusRoute.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId: CONNECTION_ID }),
    });
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      institution: {
        institutionName: "Test Bank",
        primaryAccountMask: "1234",
      },
    });
    expect(status).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION_ID,
    });

    const resolveResponse = await itemConnectionRoute.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: "item-1" }),
    });
    expect(resolveResponse.status).toBe(200);
    expect(resolveItem).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      itemId: "item-1",
    });
  });

  test("returns only a non-expired verification key through the authenticated route", async () => {
    const response = await verificationKeyRoute.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyId: "kid-1" }),
    });
    expect(response.status).toBe(200);
    expect(getPlaidWebhookVerificationKey).toHaveBeenCalledWith({
      keyId: "kid-1",
    });
    expect(await response.json()).toMatchObject({ kid: "kid-1", alg: "ES256" });
  });

  test("sync and revoke pass only opaque id plus authenticated org scope", async () => {
    const syncResponse = await syncRoute.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId: CONNECTION_ID, cursor: "cursor-1" }),
    });
    expect(syncResponse.status).toBe(200);
    expect(sync).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION_ID,
      cursor: "cursor-1",
    });

    const revokeResponse = await revokeRoute.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId: CONNECTION_ID }),
    });
    expect(revokeResponse.status).toBe(200);
    expect(revoke).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION_ID,
    });
  });

  test("preserves provider lifecycle codes for managed clients", async () => {
    sync.mockRejectedValueOnce(
      new AgentPlaidConnectorError(
        400,
        "The Item requires login.",
        "ITEM_LOGIN_REQUIRED",
      ),
    );

    const response = await syncRoute.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId: CONNECTION_ID }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "The Item requires login.",
      code: "ITEM_LOGIN_REQUIRED",
    });
  });
});
