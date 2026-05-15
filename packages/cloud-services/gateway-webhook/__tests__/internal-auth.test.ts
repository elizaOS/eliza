import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { validateInternalSecret } from "../src/internal-auth";

describe("validateInternalSecret", () => {
  const originalSecret = process.env.GATEWAY_INTERNAL_SECRET;

  beforeEach(() => {
    process.env.GATEWAY_INTERNAL_SECRET = "test-k8s-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.GATEWAY_INTERNAL_SECRET;
    } else {
      process.env.GATEWAY_INTERNAL_SECRET = originalSecret;
    }
  });

  function makeRequest(secret?: string): Request {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (secret !== undefined) {
      headers["X-Internal-Secret"] = secret;
    }
    return new Request("http://localhost/internal/event", {
      method: "POST",
      headers,
      body: "{}",
    });
  }

  test("returns false when GATEWAY_INTERNAL_SECRET env is empty", () => {
    process.env.GATEWAY_INTERNAL_SECRET = "";
    expect(validateInternalSecret(makeRequest("any-value"))).toBe(false);
  });

  test("returns false when GATEWAY_INTERNAL_SECRET env is not set", () => {
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
    expect(validateInternalSecret(makeRequest("this-is-a-much-longer-secret-value"))).toBe(false);
  });

  test("returns false for multi-byte UTF-8 secret with different encoding", () => {
    process.env.GATEWAY_INTERNAL_SECRET = "café";
    expect(validateInternalSecret(makeRequest("café"))).toBe(true);
    expect(validateInternalSecret(makeRequest("cafe"))).toBe(false);
  });

  test("returns true when header matches GATEWAY_INTERNAL_SECRET", () => {
    expect(validateInternalSecret(makeRequest("test-k8s-secret"))).toBe(true);
  });
});
