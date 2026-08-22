/**
 * Coverage for `retryDelayMs`'s RFC 7231 Retry-After parsing (delay-seconds
 * and HTTP-date forms), its exponential-backoff fallback, and the production
 * client's fail-closed transport configuration.
 */
import { describe, expect, it } from "vitest";
import { ProxyClient, retryDelayMs } from "./proxy-client";

describe("retryDelayMs", () => {
  it("parses delay-seconds form", () => {
    expect(retryDelayMs("120", 0)).toBe(120_000);
  });

  it("parses an HTTP-date in the future", () => {
    const target = new Date(Date.now() + 60_000);
    const delay = retryDelayMs(target.toUTCString(), 0);
    expect(delay).toBeGreaterThan(55_000);
    expect(delay).toBeLessThanOrEqual(60_000);
  });

  it.each(["Sunday, 06-Nov-37 08:49:37 GMT", "Sun Nov  6 08:49:37 2037"])(
    "accepts the obsolete HTTP-date form %s",
    (header) => {
      expect(retryDelayMs(header, 0)).toBeGreaterThan(0);
    },
  );

  it("clamps an HTTP-date in the past to 0, not negative", () => {
    const past = new Date(Date.now() - 60_000);
    expect(retryDelayMs(past.toUTCString(), 0)).toBe(0);
  });

  it("falls back to exponential backoff when the header is missing", () => {
    expect(retryDelayMs(null, 0)).toBe(1000);
    expect(retryDelayMs(null, 3)).toBe(8000);
  });

  it("falls back to exponential backoff instead of NaN on an unparseable header", () => {
    const delay = retryDelayMs("not-a-valid-header", 1);
    expect(delay).toBe(2000);
    expect(Number.isNaN(delay)).toBe(false);
  });

  it.each(["1.5", "1e3", "+2", "tomorrow"])(
    "rejects non-RFC numeric syntax %s",
    (header) => {
      expect(retryDelayMs(header, 1)).toBe(2000);
    },
  );

  it("bounds valid delays to the JavaScript timer maximum", () => {
    expect(retryDelayMs("999999999999999999999999", 0)).toBe(2_147_483_647);
    expect(retryDelayMs("Fri, 31 Dec 9999 23:59:59 GMT", 0)).toBe(
      2_147_483_647,
    );
  });
});

describe("ProxyClient transport policy", () => {
  const account = {
    id: "main",
    apiKey: "secret",
    proxyUrl: "https://proxy.example.test",
    deviceType: "ipad" as const,
    webhookPort: 18790,
  };

  it.each([
    "https://proxy.example.test",
    "http://127.0.0.1:4567",
    "http://[::1]:4567",
  ])(
    "accepts secure production or literal loopback simulator URL %s",
    (proxyUrl) => {
      expect(() => new ProxyClient({ ...account, proxyUrl })).not.toThrow();
    },
  );

  it.each([
    "http://localhost:4567",
    "http://192.168.1.10:4567",
    "http://proxy.example.test",
  ])("rejects non-literal insecure proxy URL %s", (proxyUrl) => {
    expect(() => new ProxyClient({ ...account, proxyUrl })).toThrow(
      "proxyUrl must use https://",
    );
  });

  it("rejects embedded credentials and invalid request budgets", () => {
    expect(
      () =>
        new ProxyClient({
          ...account,
          proxyUrl: "https://username:password@proxy.example.test",
        }),
    ).toThrow("must not include credentials");
    expect(() => new ProxyClient(account, { requestTimeoutMs: 0 })).toThrow(
      "requestTimeoutMs must be a positive integer",
    );
    expect(() => new ProxyClient(account, { retryBaseDelayMs: 1.5 })).toThrow(
      "retryBaseDelayMs must be a positive integer",
    );
    expect(
      () => new ProxyClient(account, { requestTimeoutMs: 300_001 }),
    ).toThrow(
      "requestTimeoutMs must be a positive integer no greater than 300000",
    );
    expect(() => new ProxyClient(account, { retryBaseDelayMs: 8_001 })).toThrow(
      "retryBaseDelayMs must be a positive integer no greater than 8000",
    );
  });

  it("rejects base URL query parameters before path concatenation", () => {
    expect(
      () =>
        new ProxyClient({
          ...account,
          proxyUrl: "https://proxy.example.test?tenant=unexpected",
        }),
    ).toThrow("proxyUrl must not include query parameters");
  });

  it("rejects base URL fragments instead of silently discarding them", () => {
    expect(
      () =>
        new ProxyClient({
          ...account,
          proxyUrl: "https://proxy.example.test#provider-secret",
        }),
    ).toThrow("proxyUrl must not include a fragment");
  });
});
