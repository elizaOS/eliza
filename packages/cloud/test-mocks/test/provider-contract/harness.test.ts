/** Verifies the reusable provider harness over real loopback HTTP without adapter mocks. */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { startFetchServer } from "../../src/fetch-server";
import {
  assertCompleteScenarioCatalog,
  PROVIDER_CONTRACT_SCENARIOS,
  type RunningFakeProvider,
  redactProviderDiagnostics,
  runProviderAdapterConformance,
  startFakeProvider,
} from "../../src/provider-contract";

const running: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

async function authorize(provider: RunningFakeProvider) {
  const verifier = "contract-verifier-with-sufficient-entropy-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(provider.oauthAuthorizeUrl);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: "contract-client",
    redirect_uri: "https://adapter.test/callback",
    state: "csrf-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const response = await fetch(authorize, { redirect: "manual" });
  expect(response.status).toBe(302);
  const callback = new URL(response.headers.get("location") ?? "");
  expect(callback.searchParams.get("state")).toBe("csrf-state");
  const code = callback.searchParams.get("code");
  expect(code).toMatch(/^code_/);
  const tokenResponse = await fetch(provider.oauthTokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code ?? "",
      client_id: "contract-client",
      redirect_uri: "https://adapter.test/callback",
      code_verifier: verifier,
    }),
  });
  expect(tokenResponse.status).toBe(200);
  return (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
  };
}

describe("fake provider OAuth and tenant boundary", () => {
  test("enforces state/PKCE, rotates refresh tokens, and rejects revoked or expired credentials", async () => {
    const provider = await startFakeProvider({
      now: () => Date.parse("2026-08-17T00:00:00Z"),
      fixtures: [
        {
          id: "tenant-read",
          method: "GET",
          path: "/v1/items",
          requiresAccessToken: true,
          requiresOrganization: true,
          response: { status: 200, body: { items: [{ id: "item-1" }] } },
        },
      ],
    });
    running.push(provider);

    const missingState = new URL(provider.oauthAuthorizeUrl);
    missingState.search = new URLSearchParams({
      response_type: "code",
      client_id: "contract-client",
      redirect_uri: "https://adapter.test/callback",
      code_challenge: "challenge",
      code_challenge_method: "S256",
    }).toString();
    expect((await fetch(missingState, { redirect: "manual" })).status).toBe(
      400,
    );

    const first = await authorize(provider);
    const allowed = await fetch(`${provider.url}/v1/items`, {
      headers: {
        authorization: `Bearer ${first.access_token}`,
        "x-organization-id": "org-1",
      },
    });
    expect(allowed.status).toBe(200);
    expect(
      (
        await fetch(`${provider.url}/v1/items`, {
          headers: {
            authorization: `Bearer ${first.access_token}`,
            "x-organization-id": "org-2",
          },
        })
      ).status,
    ).toBe(403);

    const rotatedResponse = await fetch(provider.oauthTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: "contract-client",
      }),
    });
    const rotated = (await rotatedResponse.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
    expect(
      (
        await fetch(provider.oauthTokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: first.refresh_token,
            client_id: "contract-client",
          }),
        })
      ).status,
    ).toBe(400);

    provider.revokeRefreshToken(rotated.refresh_token);
    expect(
      (
        await fetch(provider.oauthTokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: rotated.refresh_token,
            client_id: "contract-client",
          }),
        })
      ).status,
    ).toBe(400);
    provider.expireAccessToken(rotated.access_token);
    expect(
      (
        await fetch(`${provider.url}/v1/items`, {
          headers: {
            authorization: `Bearer ${rotated.access_token}`,
            "x-organization-id": "org-1",
          },
        })
      ).status,
    ).toBe(401);

    expect(JSON.stringify(provider.requests)).not.toContain(first.access_token);
    expect(JSON.stringify(provider.requests)).not.toContain(
      first.refresh_token,
    );
  });
});

describe("fake provider HTTP fixtures and faults", () => {
  test("serves success, empty, invalid, cursor, and retry metadata fixtures", async () => {
    const provider = await startFakeProvider({
      fixtures: [
        {
          id: "success",
          method: "GET",
          path: "/success",
          response: { status: 200, body: { value: 1 } },
        },
        {
          id: "empty",
          method: "GET",
          path: "/empty",
          response: { status: 200, body: { items: [] } },
        },
        {
          id: "invalid",
          method: "POST",
          path: "/invalid",
          response: { status: 422, body: { error: { code: "invalid_input" } } },
        },
        {
          id: "page-1",
          method: "GET",
          path: "/pages/1",
          response: {
            status: 200,
            body: { items: [1], next_cursor: "cursor-2" },
          },
        },
        {
          id: "page-2",
          method: "GET",
          path: "/pages/2",
          response: { status: 200, body: { items: [2], next_cursor: null } },
        },
        {
          id: "rate",
          method: "GET",
          path: "/rate",
          response: {
            status: 429,
            headers: { "retry-after": "7", "x-ratelimit-reset": "1786934400" },
            body: { error: { code: "rate_limited" } },
          },
        },
        {
          id: "secret-body",
          method: "POST",
          path: "/secret-body",
          response: { status: 204 },
        },
      ],
    });
    running.push(provider);

    expect(await (await fetch(`${provider.url}/success`)).json()).toEqual({
      value: 1,
    });
    expect(await (await fetch(`${provider.url}/empty`)).json()).toEqual({
      items: [],
    });
    expect(
      (await fetch(`${provider.url}/invalid`, { method: "POST" })).status,
    ).toBe(422);
    expect(await (await fetch(`${provider.url}/pages/1`)).json()).toEqual({
      items: [1],
      next_cursor: "cursor-2",
    });
    expect(await (await fetch(`${provider.url}/pages/2`)).json()).toEqual({
      items: [2],
      next_cursor: null,
    });
    const rate = await fetch(`${provider.url}/rate`);
    expect(rate.status).toBe(429);
    expect(rate.headers.get("retry-after")).toBe("7");
    expect(
      (
        await fetch(`${provider.url}/secret-body`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accessToken: "body-secret" }),
        })
      ).status,
    ).toBe(204);
    expect(JSON.stringify(provider.requests)).not.toContain("body-secret");

    provider.enqueueFault("GET", "/success", { type: "malformed-json" });
    await expect(
      fetch(`${provider.url}/success`).then((response) => response.json()),
    ).rejects.toThrow();
    provider.enqueueFault("GET", "/success", {
      type: "schema-drift",
      body: { renamed_value: 1 },
    });
    expect(await (await fetch(`${provider.url}/success`)).json()).toEqual({
      renamed_value: 1,
    });
    provider.enqueueFault("GET", "/success", {
      type: "status",
      status: 503,
      body: { error: { code: "unavailable" } },
    });
    expect((await fetch(`${provider.url}/success`)).status).toBe(503);

    provider.enqueueFault("GET", "/success", {
      type: "delay",
      durationMs: 100,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await expect(
      fetch(`${provider.url}/success`, { signal: controller.signal }),
    ).rejects.toThrow();
  });

  test("can close the upstream so adapters observe a connection failure", async () => {
    const provider = await startFakeProvider({
      fixtures: [
        {
          id: "reset-target",
          method: "GET",
          path: "/reset-target",
          response: { status: 200, body: { ok: true } },
        },
      ],
    });
    expect((await fetch(`${provider.url}/reset-target`)).status).toBe(200);
    await provider.resetConnections();
    await expect(fetch(`${provider.url}/reset-target`)).rejects.toThrow();
  });
});

describe("webhooks, policies, receipts, and redaction", () => {
  test("delivers duplicate and out-of-order signed events for idempotent handling", async () => {
    const effects = new Map<string, number>();
    const order: number[] = [];
    const receiver = await startFetchServer(async (request) => {
      const payload = await request.text();
      const timestamp = request.headers.get("x-provider-timestamp") ?? "";
      const signature = request.headers
        .get("x-provider-signature")
        ?.replace(/^v1=/, "");
      const expected = createHmac("sha256", "webhook-secret")
        .update(`${timestamp}.${payload}`)
        .digest("hex");
      if (
        !signature ||
        signature.length !== expected.length ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      ) {
        return new Response(null, { status: 401 });
      }
      const event = JSON.parse(payload) as { id: string; sequence: number };
      if (!effects.has(event.id)) {
        effects.set(event.id, 1);
        order.push(event.sequence);
      }
      return new Response(null, { status: 204 });
    });
    running.push(receiver);
    const provider = await startFakeProvider({ now: () => 1_786_934_400_000 });
    running.push(provider);
    const target = `http://${receiver.hostname}:${receiver.port}/webhook`;
    const events = [
      {
        id: "event-2",
        sequence: 2,
        type: "updated",
        tenantId: "org-1",
        accountId: "acct-contract",
        connectionId: "conn_contract",
        data: {},
      },
      {
        id: "event-1",
        sequence: 1,
        type: "created",
        tenantId: "org-1",
        accountId: "acct-contract",
        connectionId: "conn_contract",
        data: {},
      },
      {
        id: "event-2",
        sequence: 2,
        type: "updated",
        tenantId: "org-1",
        accountId: "acct-contract",
        connectionId: "conn_contract",
        data: {},
      },
    ];
    const responses = await provider.deliverWebhooks(
      target,
      events,
      "webhook-secret",
    );
    expect(responses.every((response) => response.status === 204)).toBe(true);
    expect(order).toEqual([2, 1]);
    expect(effects.size).toBe(2);

    expect(provider.receipts).toEqual([]);
    expect(provider.effects).toEqual([]);
    expect(provider.createConnectionId()).toMatch(/^conn_[A-Za-z0-9_-]{16,}$/);
    const diagnostic = redactProviderDiagnostics(
      { authorization: "Bearer access-secret", nested: "refresh-secret" },
      ["refresh-secret"],
    );
    expect(JSON.stringify(diagnostic)).toBe(
      '{"authorization":"<redacted>","nested":"<redacted>"}',
    );
  });
});

describe("adapter conformance runner", () => {
  test("covers the complete catalog and rejects missing adapter-owned scenarios", async () => {
    assertCompleteScenarioCatalog(PROVIDER_CONTRACT_SCENARIOS);
    await expect(
      runProviderAdapterConformance({
        adapterName: "incomplete-adapter",
        capabilities: ["oauth"],
        requiredScenarios: ["oauth-state-pkce"],
        scenarios: {},
      }),
    ).rejects.toThrow("oauth-state-pkce");
  });
});
