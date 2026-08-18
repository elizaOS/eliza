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
  plaidConnectionService: { exchange, sync, revoke },
}));
mock.module("@/lib/services/agent-plaid-connector", () => ({
  AgentPlaidConnectorError,
}));

const [
  { default: exchangeRoute },
  { default: syncRoute },
  { default: revokeRoute },
] = await Promise.all([
  import("./exchange/route"),
  import("./sync/route"),
  import("./revoke/route"),
]);

describe("Plaid credential-opaque routes", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    exchange.mockClear();
    sync.mockClear();
    revoke.mockClear();
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
