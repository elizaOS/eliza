/** Verifies the stable native App Auth error code and HTTP status contract. */
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { MobileAppAuthProtocolError } = await import(
  "@/lib/services/mobile-app-auth"
);
const { mobileAppAuthErrorResponse } = await import("./_response");

const cases = [
  ["authorization_code_expired", 410],
  ["authorization_complete", 409],
  ["binding_mismatch", 400],
  ["credential_proof_invalid", 401],
  ["invalid_authorization_code", 400],
  ["invalid_client", 401],
  ["invalid_code_verifier", 400],
  ["invalid_request", 400],
  ["server_configuration_error", 503],
] as const;

describe("mobile App Auth error response", () => {
  test.each(cases)("maps %s to HTTP %i", async (code, status) => {
    const app = new Hono();
    app.get("/", (c) =>
      mobileAppAuthErrorResponse(
        c,
        new MobileAppAuthProtocolError(code, "stable description"),
        "test",
      ),
    );

    const response = await app.request("/");
    expect(response.status).toBe(status);
    expect((await response.json()) as Record<string, unknown>).toEqual({
      success: false,
      error: code,
      errorDescription: "stable description",
      retryable: false,
    });
  });

  test("maps dependency failures to a retryable generic 503", async () => {
    const app = new Hono();
    app.get("/", (c) =>
      mobileAppAuthErrorResponse(
        c,
        new Error("database DSN must not leak"),
        "test",
      ),
    );

    const response = await app.request("/");
    expect(response.status).toBe(503);
    expect((await response.json()) as Record<string, unknown>).toEqual({
      success: false,
      error: "temporarily_unavailable",
      errorDescription: "Mobile authorization is temporarily unavailable",
      retryable: true,
    });
  });
});
