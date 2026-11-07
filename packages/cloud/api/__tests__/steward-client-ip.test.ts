import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { verifiedProxyClientIp } from "../../../auth/cloudflare/client-ip";
import { signStewardClientIp } from "../../shared/src/lib/steward/sign";
import type { AppEnv } from "../../shared/src/types/cloud-worker-env";
import { embeddedStewardHandler } from "../src/steward/embedded";

const secret = "test-client-attribution-secret";
const target = "https://login.example.test/auth/nonce?tenantId=test";

async function signed(ip = "203.0.113.7"): Promise<Request> {
  const headers = new Headers({ "cf-connecting-ip": "2a06:98c0:3600::103" });
  await signStewardClientIp(
    secret,
    "GET",
    "/auth/nonce?tenantId=test",
    headers,
    ip,
  );
  return new Request(target, { headers });
}

describe("cross-zone login client attribution", () => {
  test("preserves edge-observed IPv4 and IPv6 despite the cross-zone Worker address", async () => {
    expect(verifiedProxyClientIp(await signed(), secret)).toBe("203.0.113.7");
    expect(verifiedProxyClientIp(await signed("2001:db8::7"), secret)).toBe(
      "2001:db8::7",
    );
  });
  test("rejects changed address, path, query, method, expiry, or signer", async () => {
    const request = await signed();
    for (const [name, value] of [
      ["x-steward-client-ip", "203.0.113.8"],
      ["x-steward-client-ip-expires", String(Date.now() + 30_000)],
      ["x-steward-client-ip-signature", "0".repeat(64)],
    ]) {
      const headers = new Headers(request.headers);
      headers.set(name, value);
      expect(
        verifiedProxyClientIp(new Request(target, { headers }), secret),
      ).toBeUndefined();
    }
    expect(
      verifiedProxyClientIp(
        new Request(target.replace("nonce", "providers"), request),
        secret,
      ),
    ).toBeUndefined();
    expect(
      verifiedProxyClientIp(
        new Request(target.replace("tenantId=test", "tenantId=other"), request),
        secret,
      ),
    ).toBeUndefined();
    expect(
      verifiedProxyClientIp(
        new Request(target, { headers: request.headers, method: "POST" }),
        secret,
      ),
    ).toBeUndefined();
    expect(verifiedProxyClientIp(request, "wrong")).toBeUndefined();
    expect(verifiedProxyClientIp(request, undefined)).toBeUndefined();
    const expiry = Number(request.headers.get("x-steward-client-ip-expires"));
    expect(verifiedProxyClientIp(request, secret, expiry + 1)).toBeUndefined();
    expect(
      verifiedProxyClientIp(request, secret, expiry - 65_001),
    ).toBeUndefined();
  });
  test("replaces caller assertions and strips them without an edge signer", async () => {
    const headers = new Headers((await signed()).headers);
    await signStewardClientIp(
      secret,
      "GET",
      "/auth/nonce?tenantId=test",
      headers,
      "203.0.113.99",
    );
    expect(
      verifiedProxyClientIp(new Request(target, { headers }), secret),
    ).toBe("203.0.113.99");
    await signStewardClientIp(
      null,
      "GET",
      "/auth/nonce?tenantId=test",
      headers,
      "203.0.113.99",
    );
    for (const name of [
      "x-steward-client-ip",
      "x-steward-client-ip-expires",
      "x-steward-client-ip-signature",
    ])
      expect(headers.has(name)).toBe(false);
  });
  test("rejects non-IP assertions even with a valid signer", async () => {
    expect(
      verifiedProxyClientIp(await signed("203.0.113.1, 203.0.113.2"), secret),
    ).toBeUndefined();
  });
});

test("the Cloud login proxy signs only the edge-observed address", async () => {
  const previousFetch = globalThis.fetch;
  let observed = false;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const upstream = new Request(input, init);
    expect(upstream.url).toBe(
      "https://login.example.test/auth/nonce?tenantId=test",
    );
    expect(verifiedProxyClientIp(upstream, secret)).toBe("203.0.113.7");
    expect(upstream.headers.get("x-forwarded-for")).toBe("203.0.113.7");
    observed = true;
    return Response.json({ nonce: "test-nonce" });
  }) as typeof fetch;
  try {
    const app = new Hono<AppEnv>();
    app.all("/steward/*", embeddedStewardHandler);
    const response = await app.request(
      "https://cloud.example.test/steward/auth/nonce?tenantId=test",
      {
        headers: {
          "cf-connecting-ip": "203.0.113.7",
          "x-forwarded-for": "198.51.100.9",
          "x-steward-client-ip": "198.51.100.9",
          "x-steward-client-ip-signature": "0".repeat(64),
        },
      },
      {
        LOGIN_API_URL: "https://login.example.test",
        STEWARD_REQUEST_SIGNING_SECRET: secret,
      } as AppEnv["Bindings"],
    );
    expect(response.status).toBe(200);
    expect(observed).toBe(true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
