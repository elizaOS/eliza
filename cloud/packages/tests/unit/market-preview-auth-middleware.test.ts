import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

describe("market preview auth middleware", () => {
  test("allows wallet overview preview without user credentials", async () => {
    const getCurrentUser = mock(async () => {
      throw new Error("public preview route should not resolve user auth");
    });

    mock.module("@/lib/auth/workers-hono-auth", () => ({
      getCurrentUser,
    }));

    const { authMiddleware } = await import(
      new URL(`../../../apps/api/src/middleware/auth.ts?test=${Date.now()}`, import.meta.url).href
    );

    const app = new Hono();
    app.use("*", authMiddleware);
    app.get("/api/v1/market/preview/wallet-overview", (c) => c.json({ ok: true }));

    const response = await app.request(
      "https://elizacloud.ai/api/v1/market/preview/wallet-overview",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(getCurrentUser).not.toHaveBeenCalled();
  });
});
