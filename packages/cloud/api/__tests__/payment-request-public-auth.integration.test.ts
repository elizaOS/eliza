/**
 * Exercises the global auth boundary around public payment-request details.
 * The detail handler owns `?public=1`; collection and mutations stay gated.
 */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getCurrentUser = mock(async () => null);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser,
}));

const { authMiddleware } = await import("../src/middleware/auth");

const ENV = { NODE_ENV: "test" };

const app = new Hono();
app.use("*", authMiddleware);
app.get("/api/v1/payment-requests/:id", (c) =>
  c.json({ reached: true, id: c.req.param("id") }),
);
app.get("/api/v1/payment-requests", (c) => c.json({ reached: true }));
app.post("/api/v1/payment-requests/:id/cancel", (c) =>
  c.json({ reached: true, id: c.req.param("id") }),
);

describe("payment-request auth boundary", () => {
  test("lets anonymous public detail reach the handler", async () => {
    const response = await app.request(
      "https://api.example.test/api/v1/payment-requests/pr-1?public=1",
      undefined,
      ENV,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      reached: true,
      id: "pr-1",
    });
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  test("keeps collection and cancellation requests authenticated", async () => {
    const collection = await app.request(
      "https://api.example.test/api/v1/payment-requests",
      undefined,
      ENV,
    );
    const cancel = await app.request(
      "https://api.example.test/api/v1/payment-requests/pr-1/cancel",
      { method: "POST" },
      ENV,
    );

    expect(collection.status).toBe(401);
    expect(cancel.status).toBe(401);
    expect(getCurrentUser).toHaveBeenCalledTimes(2);
  });
});
