import * as http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";
import {
  handlePaymentRoutes,
  type PaymentRouteOptions,
} from "./payment-routes";
import {
  createInMemoryLocalPaymentStore,
  type LocalPaymentStore,
} from "./payment-store";

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
  routeOptions: PaymentRouteOptions,
): Promise<FakeRes> {
  const res = fakeRes();
  const handled = await handlePaymentRoutes(
    fakeReq(opts),
    res.res,
    STATE,
    routeOptions,
  );
  expect(handled).toBe(true);
  return res;
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    provider: "x402",
    amountCents: 1500,
    currency: "usd",
    reason: "test invoice",
    paymentContext: { kind: "any_payer" },
    metadata: {},
    ...overrides,
  };
}

describe("local payment routes", () => {
  const originalApiToken = process.env.ELIZA_API_TOKEN;
  const originalRequireLocalAuth = process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  const originalCloudProvisioned = process.env.ELIZA_CLOUD_PROVISIONED;

  let store: LocalPaymentStore;
  let now: number;
  let baseOptions: PaymentRouteOptions;

  beforeEach(() => {
    store = createInMemoryLocalPaymentStore();
    now = Date.parse("2026-05-10T12:00:00.000Z");
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    baseOptions = {
      store,
      now: () => now,
      publicBaseUrl: () => "https://tunnel.example",
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalApiToken === undefined) delete process.env.ELIZA_API_TOKEN;
    else process.env.ELIZA_API_TOKEN = originalApiToken;
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

  it("creates a payment request and retrieves it via GET", async () => {
    const created = (
      await callRoute(
        {
          method: "POST",
          pathname: "/api/payment-requests",
          body: createBody(),
        },
        baseOptions,
      )
    ).body() as {
      ok: true;
      paymentRequestId: string;
      hostedUrl: string;
      expiresAt: number;
    };
    expect(created.paymentRequestId).toEqual(expect.any(String));
    expect(created.hostedUrl).toContain(created.paymentRequestId);
    expect(created.expiresAt).toBeGreaterThan(now);

    const fetched = await callRoute(
      {
        method: "GET",
        pathname: `/api/payment-requests/${created.paymentRequestId}`,
      },
      baseOptions,
    );
    expect(fetched.status()).toBe(200);
    const body = fetched.body() as {
      ok: true;
      request: { id: string; amountCents: number; status: string };
    };
    expect(body.request.id).toBe(created.paymentRequestId);
    expect(body.request.amountCents).toBe(1500);
    expect(body.request.status).toBe("pending");
  });

  it("rejects unsupported provider", async () => {
    const res = await callRoute(
      {
        method: "POST",
        pathname: "/api/payment-requests",
        body: createBody({ provider: "stripe" }),
      },
      baseOptions,
    );
    expect(res.status()).toBe(400);
    expect(res.body()).toMatchObject({
      error: "provider_not_supported_in_local_mode",
    });
  });

  it("cancels an owner-authenticated request", async () => {
    const created = (
      await callRoute(
        {
          method: "POST",
          pathname: "/api/payment-requests",
          body: createBody(),
        },
        baseOptions,
      )
    ).body() as { paymentRequestId: string };

    const canceled = await callRoute(
      {
        method: "POST",
        pathname: `/api/payment-requests/${created.paymentRequestId}/cancel`,
        body: {},
      },
      baseOptions,
    );
    expect(canceled.status()).toBe(200);
    expect(
      (canceled.body() as { request: { status: string } }).request.status,
    ).toBe("canceled");

    // Cannot cancel a terminal request again
    const second = await callRoute(
      {
        method: "POST",
        pathname: `/api/payment-requests/${created.paymentRequestId}/cancel`,
        body: {},
      },
      baseOptions,
    );
    expect(second.status()).toBe(409);
  });

  it("expires an owner-authenticated request", async () => {
    const created = (
      await callRoute(
        {
          method: "POST",
          pathname: "/api/payment-requests",
          body: createBody(),
        },
        baseOptions,
      )
    ).body() as { paymentRequestId: string };

    const expired = await callRoute(
      {
        method: "POST",
        pathname: `/api/payment-requests/${created.paymentRequestId}/expire`,
        body: {},
      },
      baseOptions,
    );
    expect(expired.status()).toBe(200);
    expect(
      (expired.body() as { request: { status: string } }).request.status,
    ).toBe("expired");
  });

  it("accepts a valid payment proof and emits PaymentSettled", async () => {
    const onSettled = vi.fn(async () => {});
    const verifyProof = vi.fn(async () => ({
      ok: true as const,
      txRef: "0xdeadbeef",
    }));
    const options: PaymentRouteOptions = {
      ...baseOptions,
      verifyProof,
      onSettled,
    };

    const created = (
      await callRoute(
        {
          method: "POST",
          pathname: "/api/payment-requests",
          body: createBody(),
        },
        options,
      )
    ).body() as { paymentRequestId: string };

    const submitted = await callRoute(
      {
        method: "POST",
        pathname: `/api/payment-requests/${created.paymentRequestId}/proof`,
        body: { proof: { signature: "0xabcd" } },
      },
      options,
    );

    expect(submitted.status()).toBe(200);
    const body = submitted.body() as {
      ok: true;
      request: { status: string; txRef?: string };
      event: { kind: string; paymentRequestId: string };
    };
    expect(body.request.status).toBe("settled");
    expect(body.request.txRef).toBe("0xdeadbeef");
    expect(body.event.kind).toBe("PaymentSettled");
    expect(verifyProof).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid proof and marks the request failed", async () => {
    const verifyProof = vi.fn(async () => ({
      ok: false as const,
      reason: "bad_signature",
    }));
    const options: PaymentRouteOptions = { ...baseOptions, verifyProof };

    const created = (
      await callRoute(
        {
          method: "POST",
          pathname: "/api/payment-requests",
          body: createBody(),
        },
        options,
      )
    ).body() as { paymentRequestId: string };

    const submitted = await callRoute(
      {
        method: "POST",
        pathname: `/api/payment-requests/${created.paymentRequestId}/proof`,
        body: { proof: { signature: "bogus" } },
      },
      options,
    );
    expect(submitted.status()).toBe(400);
    expect(submitted.body()).toMatchObject({
      ok: false,
      error: "bad_signature",
    });

    const refetched = await callRoute(
      {
        method: "GET",
        pathname: `/api/payment-requests/${created.paymentRequestId}`,
      },
      options,
    );
    expect(
      (refetched.body() as { request: { status: string } }).request.status,
    ).toBe("failed");
  });

  it("redacts payerIdentityId and metadata.callbackSecret for non-owner GET", async () => {
    process.env.ELIZA_API_TOKEN = "owner-token";
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";

    const created = (
      await callRoute(
        {
          method: "POST",
          pathname: "/api/payment-requests",
          body: createBody({
            paymentContext: {
              kind: "specific_payer",
              payerIdentityId: "payer-secret-id",
            },
            metadata: { callbackSecret: "shh-supersecret", visible: "ok" },
          }),
          headers: { "x-api-key": "owner-token" },
        },
        baseOptions,
      )
    ).body() as { paymentRequestId: string };

    const ownerView = await callRoute(
      {
        method: "GET",
        pathname: `/api/payment-requests/${created.paymentRequestId}`,
        headers: { "x-api-key": "owner-token" },
      },
      baseOptions,
    );
    const ownerBody = ownerView.body() as {
      request: {
        paymentContext: { payerIdentityId?: string };
        metadata: { callbackSecret?: string; visible?: string };
      };
    };
    expect(ownerBody.request.paymentContext.payerIdentityId).toBe(
      "payer-secret-id",
    );
    expect(ownerBody.request.metadata.callbackSecret).toBe("shh-supersecret");

    const publicView = await callRoute(
      {
        method: "GET",
        pathname: `/api/payment-requests/${created.paymentRequestId}`,
        ip: "203.0.113.5",
        host: "tunnel.example",
        headers: {},
      },
      baseOptions,
    );
    const publicBody = publicView.body() as {
      request: {
        paymentContext: { payerIdentityId?: string };
        metadata: { callbackSecret?: string; visible?: string };
      };
    };
    expect(publicBody.request.paymentContext.payerIdentityId).toBe(
      "[REDACTED]",
    );
    expect(publicBody.request.metadata.callbackSecret).toBe("[REDACTED]");
    expect(publicBody.request.metadata.visible).toBe("ok");
    expect(publicView.text()).not.toContain("payer-secret-id");
    expect(publicView.text()).not.toContain("shh-supersecret");
  });

  it("renders an HTML page for the hosted URL containing the request id and amount", async () => {
    const created = (
      await callRoute(
        {
          method: "POST",
          pathname: "/api/payment-requests",
          body: createBody(),
        },
        baseOptions,
      )
    ).body() as { paymentRequestId: string };

    const page = await callRoute(
      {
        method: "GET",
        pathname: `/api/payment-requests/${created.paymentRequestId}/page`,
        ip: "203.0.113.5",
        host: "tunnel.example",
      },
      baseOptions,
    );
    expect(page.status()).toBe(200);
    const html = page.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain(created.paymentRequestId);
    expect(html).toContain("15.00 USD");
    expect(html).toContain(
      `/api/payment-requests/${created.paymentRequestId}/proof`,
    );
  });

  it("rejects invalid amountCents", async () => {
    const res = await callRoute(
      {
        method: "POST",
        pathname: "/api/payment-requests",
        body: createBody({ amountCents: -5 }),
      },
      baseOptions,
    );
    expect(res.status()).toBe(400);
    expect(res.body()).toMatchObject({ error: "invalid amountCents" });
  });
});
