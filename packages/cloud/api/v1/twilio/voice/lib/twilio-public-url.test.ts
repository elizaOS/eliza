/**
 * Twilio signed-webhook URL resolution contract: authority derives only from
 * the configured credential-free HTTPS origin, the request query is preserved
 * (part of Twilio's signed callback), and every invalid configuration fails
 * closed with a distinct ElizaError code.
 */

import { describe, expect, test } from "bun:test";

import { resolveTwilioPublicUrl } from "./twilio-public-url";

interface Context {
  env: { TWILIO_PUBLIC_URL?: string };
  req: { url: string };
}

function context(overrides: Partial<Context> = {}): Context {
  return {
    env: { TWILIO_PUBLIC_URL: "https://voice.example.com" },
    req: { url: "https://orig.example.com/api/current?call=SID123&a=1" },
    ...overrides,
  };
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

describe("resolveTwilioPublicUrl", () => {
  test("builds a URL from the configured origin with the request query preserved", () => {
    const url = resolveTwilioPublicUrl(
      context(),
      "/api/v1/twilio/voice/status",
    );
    expect(url.origin).toBe("https://voice.example.com");
    expect(url.pathname).toBe("/api/v1/twilio/voice/status");
    expect(url.search).toBe("?call=SID123&a=1");
    expect(url.username).toBe("");
    expect(url.password).toBe("");
  });

  test("trims surrounding whitespace from the configured origin", () => {
    const url = resolveTwilioPublicUrl(
      context({ env: { TWILIO_PUBLIC_URL: "  https://voice.example.com  " } }),
      "/callback",
    );
    expect(url.origin).toBe("https://voice.example.com");
  });

  test("fails closed when TWILIO_PUBLIC_URL is missing", () => {
    const error = captureError(() =>
      resolveTwilioPublicUrl(context({ env: {} }), "/callback"),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe(
      "TWILIO_PUBLIC_URL_REQUIRED",
    );
    expect((error as Error).message).toContain("TWILIO_PUBLIC_URL");
  });

  test("fails closed when the configured value is not a parseable URL", () => {
    const error = captureError(() =>
      resolveTwilioPublicUrl(
        context({ env: { TWILIO_PUBLIC_URL: "not a url" } }),
        "/callback",
      ),
    );
    expect((error as { code?: string }).code).toBe("TWILIO_PUBLIC_URL_INVALID");
    expect((error as { cause?: unknown }).cause).toBeDefined();
  });

  test("rejects a non-HTTPS origin", () => {
    const error = captureError(() =>
      resolveTwilioPublicUrl(
        context({ env: { TWILIO_PUBLIC_URL: "http://voice.example.com" } }),
        "/callback",
      ),
    );
    expect((error as { code?: string }).code).toBe("TWILIO_PUBLIC_URL_INVALID");
  });

  test("rejects an origin with embedded credentials", () => {
    const error = captureError(() =>
      resolveTwilioPublicUrl(
        context({
          env: { TWILIO_PUBLIC_URL: "https://user:pass@voice.example.com" },
        }),
        "/callback",
      ),
    );
    expect((error as { code?: string }).code).toBe("TWILIO_PUBLIC_URL_INVALID");
  });

  test("rejects a configured origin with a non-root path", () => {
    const error = captureError(() =>
      resolveTwilioPublicUrl(
        context({
          env: { TWILIO_PUBLIC_URL: "https://voice.example.com/base" },
        }),
        "/callback",
      ),
    );
    expect((error as { code?: string }).code).toBe("TWILIO_PUBLIC_URL_INVALID");
  });

  test("rejects a configured origin carrying a query string", () => {
    const error = captureError(() =>
      resolveTwilioPublicUrl(
        context({
          env: { TWILIO_PUBLIC_URL: "https://voice.example.com?x=1" },
        }),
        "/callback",
      ),
    );
    expect((error as { code?: string }).code).toBe("TWILIO_PUBLIC_URL_INVALID");
  });

  test("rejects a configured origin carrying a hash fragment", () => {
    const error = captureError(() =>
      resolveTwilioPublicUrl(
        context({
          env: { TWILIO_PUBLIC_URL: "https://voice.example.com#frag" },
        }),
        "/callback",
      ),
    );
    expect((error as { code?: string }).code).toBe("TWILIO_PUBLIC_URL_INVALID");
  });
});
