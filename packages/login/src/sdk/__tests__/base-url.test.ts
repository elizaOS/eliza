/**
 * SEC-048 — HTTPS enforcement on SDK baseUrl.
 *
 * LoginClient, LoginAuth, and AgentClient transmit platform keys, app
 * secrets, bearer tokens, and HMAC-signed credentials. Plaintext non-loopback
 * baseUrls must be rejected by default (the CLI has always enforced this);
 * loopback http stays allowed for local development, and an explicit
 * allowInsecureBaseUrl opt-out warns loudly for trusted private networks.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { AgentKeypair } from "../agent-keypair";
import { LoginAuth } from "../auth";
import { assertSecureBaseUrl, stripTrailingSlashes } from "../base-url";
import { LoginClient } from "../client";

describe("assertSecureBaseUrl", () => {
  test("accepts HTTPS and loopback HTTP", () => {
    expect(() =>
      assertSecureBaseUrl("https://api.steward.example"),
    ).not.toThrow();
    expect(() => assertSecureBaseUrl("http://localhost:3200")).not.toThrow();
    expect(() => assertSecureBaseUrl("http://127.0.0.1:3200")).not.toThrow();
    expect(() => assertSecureBaseUrl("http://[::1]:3200")).not.toThrow();
  });

  test("rejects plaintext non-loopback baseUrls", () => {
    expect(() => assertSecureBaseUrl("http://api.steward.example")).toThrow(
      /must use HTTPS/,
    );
    expect(() => assertSecureBaseUrl("http://192.168.1.10:3200")).toThrow(
      /must use HTTPS/,
    );
    expect(() => assertSecureBaseUrl("ftp://api.steward.example")).toThrow(
      /must use HTTP\(S\)/,
    );
    expect(() => assertSecureBaseUrl("not-a-url")).toThrow(
      /valid absolute URL/,
    );
  });

  test("rejects credential-bearing and ambiguous base URLs before any opt-out", () => {
    expect(() =>
      assertSecureBaseUrl("https://user:secret@api.steward.example"),
    ).toThrow(/must not embed credentials/);
    expect(() =>
      assertSecureBaseUrl("http://user:secret@localhost:3200", true),
    ).toThrow(/must not embed credentials/);
    expect(() =>
      assertSecureBaseUrl("https://api.steward.example?token=secret"),
    ).toThrow(/query or fragment/);
    expect(() => assertSecureBaseUrl("file:///tmp/steward", true)).toThrow(
      /must use HTTP\(S\)/,
    );
  });

  test("allowInsecureBaseUrl opts out but warns loudly", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() =>
        assertSecureBaseUrl("http://api.steward.example", true),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("not HTTPS");
    } finally {
      warn.mockRestore();
    }
  });

  test("the insecure opt-out permits HTTP only, never arbitrary URL schemes", () => {
    expect(() =>
      assertSecureBaseUrl("ftp://api.steward.example", true),
    ).toThrow(/HTTP\(S\)/);
  });
});

test("trailing slash normalization stays linear on adversarial input", () => {
  const suffix = "/".repeat(200_000);
  expect(stripTrailingSlashes(`https://api.steward.example${suffix}`)).toBe(
    "https://api.steward.example",
  );
  expect(stripTrailingSlashes(`${suffix}x`)).toBe(`${suffix}x`);
});

describe("SDK constructors enforce HTTPS baseUrl", () => {
  test("LoginClient rejects plaintext non-loopback baseUrl", () => {
    expect(
      () => new LoginClient({ baseUrl: "http://api.steward.example" }),
    ).toThrow(/must use HTTPS/);
    expect(
      () => new LoginClient({ baseUrl: "http://localhost:3200" }),
    ).not.toThrow();
    expect(
      () => new LoginClient({ baseUrl: "https://api.steward.example" }),
    ).not.toThrow();
  });

  test("LoginAuth rejects plaintext non-loopback baseUrl", () => {
    expect(
      () => new LoginAuth({ baseUrl: "http://api.steward.example" }),
    ).toThrow(/must use HTTPS/);
    expect(
      () => new LoginAuth({ baseUrl: "http://localhost:3200" }),
    ).not.toThrow();
    expect(
      () => new LoginAuth({ baseUrl: "https://api.steward.example" }),
    ).not.toThrow();
  });
});
