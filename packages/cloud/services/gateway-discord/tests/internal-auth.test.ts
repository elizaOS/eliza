/**
 * Exercises the internal-secret gate on the gateway's operational endpoints
 * (`/drain`, `/status`, `/metrics`). The verifier tests drive the real
 * `validateInternalSecret`; the contract tests pin the route wiring in
 * `src/index.ts` so the guard cannot be dropped without failing CI.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { validateInternalSecret } from "../src/internal-auth";

describe("validateInternalSecret", () => {
  const originalSecret = process.env.GATEWAY_INTERNAL_SECRET;

  beforeEach(() => {
    process.env.GATEWAY_INTERNAL_SECRET = "test-internal-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.GATEWAY_INTERNAL_SECRET;
    } else {
      process.env.GATEWAY_INTERNAL_SECRET = originalSecret;
    }
  });

  function makeRequest(secret?: string): Request {
    const headers: Record<string, string> = {};
    if (secret !== undefined) {
      headers["X-Internal-Secret"] = secret;
    }
    return new Request("http://localhost/drain", { method: "POST", headers });
  }

  test("fails closed when GATEWAY_INTERNAL_SECRET env is empty", () => {
    process.env.GATEWAY_INTERNAL_SECRET = "";
    expect(validateInternalSecret(makeRequest("any-value"))).toBe(false);
  });

  test("fails closed when GATEWAY_INTERNAL_SECRET env is not set", () => {
    delete process.env.GATEWAY_INTERNAL_SECRET;
    expect(validateInternalSecret(makeRequest("any-value"))).toBe(false);
  });

  test("returns false when header is missing", () => {
    expect(validateInternalSecret(makeRequest())).toBe(false);
  });

  test("returns false when header value is wrong", () => {
    expect(validateInternalSecret(makeRequest("wrong-secret"))).toBe(false);
  });

  test("returns false when header does not match secret (length and value differ)", () => {
    process.env.GATEWAY_INTERNAL_SECRET = "short";
    expect(
      validateInternalSecret(makeRequest("this-is-a-much-longer-secret-value")),
    ).toBe(false);
  });

  test("returns false when the header is a prefix or extension of the secret", () => {
    process.env.GATEWAY_INTERNAL_SECRET = "secret";
    expect(validateInternalSecret(makeRequest("secret"))).toBe(true);
    expect(validateInternalSecret(makeRequest("secre"))).toBe(false);
    expect(validateInternalSecret(makeRequest("secret2"))).toBe(false);
  });

  test("returns true for multi-byte UTF-8 secret with matching encoding", () => {
    process.env.GATEWAY_INTERNAL_SECRET = "café";
    expect(validateInternalSecret(makeRequest("café"))).toBe(true);
    expect(validateInternalSecret(makeRequest("cafe"))).toBe(false);
  });

  test("returns true when header matches GATEWAY_INTERNAL_SECRET", () => {
    expect(validateInternalSecret(makeRequest("test-internal-secret"))).toBe(
      true,
    );
  });
});

describe("operational route auth wiring", () => {
  const indexSource = async () =>
    Bun.file(new URL("../src/index.ts", import.meta.url)).text();

  test("/drain, /status, and /metrics require the internal secret", async () => {
    const source = await indexSource();
    for (const route of ['"/drain"', '"/metrics"', '"/status"']) {
      const routeIndex = source.indexOf(route);
      expect(routeIndex).toBeGreaterThan(-1);
      const handler = source.slice(routeIndex, routeIndex + 400);
      expect(handler).toContain("validateInternalSecret(c.req.raw)");
      expect(handler).toContain("401");
    }
  });

  test("/health and /ready stay unauthenticated for probes", async () => {
    const source = await indexSource();
    for (const route of ['"/health"', '"/ready"']) {
      const routeIndex = source.indexOf(route);
      expect(routeIndex).toBeGreaterThan(-1);
      const handler = source.slice(routeIndex, routeIndex + 300);
      expect(handler).not.toContain("validateInternalSecret");
    }
  });
});
