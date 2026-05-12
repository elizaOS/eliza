import * as http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";
import {
  handleSensitiveRequestRoutes,
  type SensitiveRequestRouteOptions,
} from "./sensitive-request-routes";
import { LocalSensitiveRequestStore } from "./sensitive-request-store";

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

interface FakeRes {
  res: http.ServerResponse;
  body(): unknown;
  text(): string;
  status(): number;
}

function fakeRes(): FakeRes {
  let bodyText = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = () => res;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    body() {
      return bodyText.length > 0 ? JSON.parse(bodyText) : null;
    },
    text() {
      return bodyText;
    },
    status() {
      return res.statusCode;
    },
  };
}

function fakeReq(opts: {
  method: string;
  pathname: string;
  body?: unknown;
  ip?: string;
  host?: string;
  headers?: http.IncomingHttpHeaders;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = opts.method;
  req.url = opts.pathname;
  req.headers = {
    host: opts.host ?? "localhost:2138",
    ...(opts.headers ?? {}),
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: opts.ip ?? "127.0.0.1",
    configurable: true,
  });
  if (opts.body !== undefined) {
    (req as { body?: unknown }).body = opts.body;
  }
  return req;
}

async function callRoute(
  opts: Parameters<typeof fakeReq>[0],
  routeOptions: SensitiveRequestRouteOptions,
): Promise<FakeRes> {
  const res = fakeRes();
  const handled = await handleSensitiveRequestRoutes(
    fakeReq(opts),
    res.res,
    STATE,
    routeOptions,
  );
  expect(handled).toBe(true);
  return res;
}

function secretCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: "secret",
    agentId: "agent-local",
    source: "public",
    target: { kind: "secret", key: "OPENAI_API_KEY" },
    ...overrides,
  };
}

describe("local sensitive request routes", () => {
  const originalApiToken = process.env.ELIZA_API_TOKEN;
  const originalTunnelAuth = process.env.ELIZA_TUNNEL_SENSITIVE_REQUEST_AUTH;
  const originalRequireLocalAuth = process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  const originalCloudProvisioned = process.env.ELIZA_CLOUD_PROVISIONED;

  let store: LocalSensitiveRequestStore;
  let now: number;

  beforeEach(() => {
    store = new LocalSensitiveRequestStore();
    now = Date.parse("2026-05-10T12:00:00.000Z");
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.ELIZA_TUNNEL_SENSITIVE_REQUEST_AUTH;
    delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalApiToken === undefined) delete process.env.ELIZA_API_TOKEN;
    else process.env.ELIZA_API_TOKEN = originalApiToken;
    if (originalTunnelAuth === undefined) {
      delete process.env.ELIZA_TUNNEL_SENSITIVE_REQUEST_AUTH;
    } else {
      process.env.ELIZA_TUNNEL_SENSITIVE_REQUEST_AUTH = originalTunnelAuth;
    }
    if (originalRequireLocalAuth === undefined) {
      delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
    } else {
      process.env.ELIZA_REQUIRE_LOCAL_AUTH = originalRequireLocalAuth;
    }
    if (originalCloudProvisioned === undefined) {
      delete process.env.ELIZA_CLOUD_PROVISIONED;
    } else {
      process.env.ELIZA_CLOUD_PROVISIONED = originalCloudProvisioned;
    }
  });

  it("creates a no-tunnel fallback request without issuing a public link", async () => {
    const res = await callRoute(
      {
        method: "POST",
        pathname: "/api/sensitive-requests",
        body: secretCreateBody(),
      },
      { store, now: () => now },
    );

    expect(res.status()).toBe(201);
    const body = res.body() as {
      submitToken: string;
      request: { delivery: { mode: string; linkBaseUrl?: string } };
    };
    expect(body.submitToken).toEqual(expect.any(String));
    expect(body.request.delivery.mode).toBe("dm_or_owner_app_instruction");
    expect(body.request.delivery.linkBaseUrl).toBeUndefined();
    expect(JSON.stringify(body.request)).not.toContain(body.submitToken);
  });

  it("allows authenticated tunnel delivery with a request token and API auth", async () => {
    process.env.ELIZA_API_TOKEN = "api-token";
    const fulfillSecret = vi.fn(async () => {});
    const routeOptions: SensitiveRequestRouteOptions = {
      store,
      now: () => now,
      isLocalSensitiveRequestAuthConfigured: () => true,
      getTunnelStatus: () => ({
        active: true,
        url: "https://example-tunnel.ngrok.app",
      }),
      fulfillSecret,
    };

    const created = (
      await callRoute(
        {
          method: "POST",
          pathname: "/api/sensitive-requests",
          body: secretCreateBody(),
        },
        routeOptions,
      )
    ).body() as {
      submitToken: string;
      request: { id: string; delivery: { mode: string; linkBaseUrl?: string } };
    };

    expect(created.request.delivery.mode).toBe("tunnel_authenticated_link");
    expect(created.request.delivery.linkBaseUrl).toBe(
      "https://example-tunnel.ngrok.app",
    );

    const submitted = await callRoute(
      {
        method: "POST",
        pathname: `/api/sensitive-requests/${created.request.id}/submit`,
        ip: "203.0.113.9",
        host: "example-tunnel.ngrok.app",
        headers: { "x-api-key": "api-token" },
        body: { token: created.submitToken, value: "sk-test-canary" },
      },
      routeOptions,
    );

    expect(submitted.status()).toBe(200);
    expect(fulfillSecret).toHaveBeenCalledTimes(1);
    const fulfillSecretCall = fulfillSecret.mock.calls[0] as
      | unknown[]
      | undefined;
    expect(fulfillSecretCall?.[1]).toBe("sk-test-canary");
    expect(submitted.text()).not.toContain("sk-test-canary");
    expect(submitted.body()).toMatchObject({
      ok: true,
      event: {
        kind: "secret.set",
        key: "OPENAI_API_KEY",
      },
    });
  });

  it("rejects a tunnel request when local sensitive-request auth is not configured", async () => {
    const fulfillSecret = vi.fn(async () => {});
    const createOptions: SensitiveRequestRouteOptions = {
      store,
      now: () => now,
      isLocalSensitiveRequestAuthConfigured: () => true,
      getTunnelStatus: () => ({
        active: true,
        url: "https://example-tunnel.ngrok.app",
      }),
      fulfillSecret,
    };
    const created = (
      await callRoute(
        {
          method: "POST",
          pathname: "/api/sensitive-requests",
          body: secretCreateBody(),
        },
        createOptions,
      )
    ).body() as { submitToken: string; request: { id: string } };

    const rejected = await callRoute(
      {
        method: "POST",
        pathname: `/api/sensitive-requests/${created.request.id}/submit`,
        body: { token: created.submitToken, value: "should-not-store" },
      },
      {
        store,
        now: () => now,
        isLocalSensitiveRequestAuthConfigured: () => false,
        fulfillSecret,
      },
    );

    expect(rejected.status()).toBe(403);
    expect(rejected.body()).toMatchObject({
      error: "local_sensitive_request_auth_required_for_tunnel",
    });
    expect(fulfillSecret).not.toHaveBeenCalled();
    expect(rejected.text()).not.toContain("should-not-store");
  });

  it("rejects expired and replayed submit tokens", async () => {
    const fulfillSecret = vi.fn(async () => {});
    const expired = (
      await callRoute(
        {
          method: "POST",
          pathname: "/api/sensitive-requests",
          body: secretCreateBody({
            target: { kind: "secret", key: "EXPIRED_KEY" },
            ttlMs: 5,
          }),
        },
        { store, now: () => now, fulfillSecret },
      )
    ).body() as { submitToken: string; request: { id: string } };
    now += 10;

    const expiredSubmit = await callRoute(
      {
        method: "POST",
        pathname: `/api/sensitive-requests/${expired.request.id}/submit`,
        body: { token: expired.submitToken, value: "expired-secret" },
      },
      { store, now: () => now, fulfillSecret },
    );

    expect(expiredSubmit.status()).toBe(410);
    expect(expiredSubmit.body()).toMatchObject({ error: "expired" });

    now = Date.parse("2026-05-10T12:01:00.000Z");
    const replayed = (
      await callRoute(
        {
          method: "POST",
          pathname: "/api/sensitive-requests",
          body: secretCreateBody({
            target: { kind: "secret", key: "REPLAY_KEY" },
          }),
        },
        { store, now: () => now, fulfillSecret },
      )
    ).body() as { submitToken: string; request: { id: string } };

    const first = await callRoute(
      {
        method: "POST",
        pathname: `/api/sensitive-requests/${replayed.request.id}/submit`,
        body: { token: replayed.submitToken, value: "first-secret" },
      },
      { store, now: () => now, fulfillSecret },
    );
    expect(first.status()).toBe(200);

    const second = await callRoute(
      {
        method: "POST",
        pathname: `/api/sensitive-requests/${replayed.request.id}/submit`,
        body: { token: replayed.submitToken, value: "second-secret" },
      },
      { store, now: () => now, fulfillSecret },
    );
    expect(second.status()).toBe(409);
    expect(second.body()).toMatchObject({ error: "replayed" });
    expect(second.text()).not.toContain("second-secret");
  });

  it("returns redacted views and handles private_info through the fulfillment hook", async () => {
    const privateInfoHook = vi.fn(async () => {});
    const canaryEmail = "private-canary@example.com";
    const created = (
      await callRoute(
        {
          method: "POST",
          pathname: "/api/sensitive-requests",
          body: {
            kind: "private_info",
            agentId: "agent-local",
            source: "owner_app_private",
            ownerAppPrivateChat: true,
            target: {
              kind: "private_info",
              fields: [
                {
                  name: "billing_email",
                  label: "Billing email",
                  required: true,
                },
              ],
              storage: { kind: "workflow_input", key: "billing" },
            },
          },
        },
        { store, now: () => now, fulfillPrivateInfo: privateInfoHook },
      )
    ).body() as { submitToken: string; request: { id: string } };

    const submitted = await callRoute(
      {
        method: "POST",
        pathname: `/api/sensitive-requests/${created.request.id}/submit`,
        body: {
          token: created.submitToken,
          fields: { billing_email: canaryEmail },
        },
      },
      { store, now: () => now, fulfillPrivateInfo: privateInfoHook },
    );

    expect(submitted.status()).toBe(200);
    expect(privateInfoHook).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.request.id }),
      { billing_email: canaryEmail },
    );
    expect(submitted.text()).not.toContain(canaryEmail);
    expect(submitted.text()).not.toContain(created.submitToken);

    const view = await callRoute(
      {
        method: "GET",
        pathname: `/api/sensitive-requests/${created.request.id}`,
      },
      { store, now: () => now },
    );
    expect(view.status()).toBe(200);
    expect(view.text()).not.toContain(canaryEmail);
    expect(view.text()).not.toContain(created.submitToken);
    expect(view.body()).toMatchObject({
      ok: true,
      request: {
        status: "fulfilled",
        target: { kind: "private_info" },
      },
    });
  });
});
