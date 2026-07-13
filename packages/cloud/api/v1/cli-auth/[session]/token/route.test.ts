/**
 * Legacy CLI token retrieval is exercised through its real Hono route while
 * the durable session service is isolated to cover every HTTP boundary state.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

type Session = {
  consumed_at: Date | null;
  expires_at: Date;
  status: "pending" | "authenticated" | "expired";
};

type ClaimResult =
  | {
      status: "claimed";
      apiKey: string;
      keyPrefix: string;
      expiresAt: Date;
    }
  | {
      status: "unavailable";
      reason: "already-consumed";
    };

const getSession = mock(
  async (_sessionId: string): Promise<Session | null> => ({
    consumed_at: null,
    expires_at: new Date(Date.now() + 60_000),
    status: "authenticated",
  }),
);

const getAndClearApiKey = mock(
  async (_sessionId: string): Promise<ClaimResult> => ({
    status: "claimed",
    apiKey: "eliz_legacy_single_use",
    keyPrefix: "eliz_leg",
    expiresAt: new Date("2026-08-01T00:00:00.000Z"),
  }),
);

const loggerError = mock(() => undefined);

mock.module("@/lib/services/cli-auth-sessions", () => ({
  cliAuthSessionsService: { getAndClearApiKey, getSession },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: loggerError },
}));

const { default: tokenRoute } = await import("./route");

const app = new Hono();
app.route("/api/v1/cli-auth/:session/token", tokenRoute);

function poll(session = "session-1", origin?: string) {
  return app.fetch(
    new Request(`https://api.example.test/api/v1/cli-auth/${session}/token`, {
      headers: origin ? { origin } : undefined,
    }),
  );
}

describe("GET /api/v1/cli-auth/:session/token", () => {
  beforeEach(() => {
    getSession.mockReset();
    getAndClearApiKey.mockReset();
    loggerError.mockClear();
    getSession.mockResolvedValue({
      consumed_at: null,
      expires_at: new Date(Date.now() + 60_000),
      status: "authenticated",
    });
    getAndClearApiKey.mockResolvedValue({
      status: "claimed",
      apiKey: "eliz_legacy_single_use",
      keyPrefix: "eliz_leg",
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    });
  });

  test("reveals a claimed key once and preserves CORS", async () => {
    const response = await poll("session-1", "http://localhost:5173");

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    await expect(response.json()).resolves.toEqual({
      apiKey: "eliz_legacy_single_use",
      keyPrefix: "eliz_leg",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    expect(getAndClearApiKey).toHaveBeenCalledWith("session-1");
  });

  test("returns explicit non-secret states before a session is claimable", async () => {
    getSession.mockResolvedValueOnce(null);
    expect((await poll()).status).toBe(404);

    getSession.mockResolvedValueOnce({
      consumed_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      status: "authenticated",
    });
    expect((await poll()).status).toBe(410);

    getSession.mockResolvedValueOnce({
      consumed_at: null,
      expires_at: new Date(Date.now() - 1),
      status: "authenticated",
    });
    expect((await poll()).status).toBe(410);

    getSession.mockResolvedValueOnce({
      consumed_at: null,
      expires_at: new Date(Date.now() + 60_000),
      status: "pending",
    });
    const pending = await poll();
    expect(pending.status).toBe(202);
    await expect(pending.json()).resolves.toEqual({ status: "pending" });
    expect(getAndClearApiKey).not.toHaveBeenCalled();
  });

  test("keeps losing claim outcomes plaintext-free", async () => {
    getAndClearApiKey.mockResolvedValueOnce({
      status: "unavailable",
      reason: "already-consumed",
    });

    const response = await poll();
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body).toEqual({ error: "Token unavailable: already-consumed" });
    expect(JSON.stringify(body)).not.toContain("eliz_");
  });

  test("translates service failures without exposing their details", async () => {
    getAndClearApiKey.mockRejectedValueOnce(new Error("kms ciphertext leaked"));

    const response = await poll();
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to retrieve CLI token",
    });
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  test("answers preflight without touching persistence", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/api/v1/cli-auth/session-1/token", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:5173" },
      }),
    );

    expect(response.status).toBe(204);
    expect(getSession).not.toHaveBeenCalled();
  });
});
