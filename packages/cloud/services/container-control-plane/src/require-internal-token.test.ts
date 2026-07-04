/**
 * H4 (#12230): the container control-plane sidecar performs privileged,
 * cross-tenant container mutations. Its internal-token gate must fail CLOSED:
 *
 *  - token UNSET  → refuse every request (503), never allow-all.
 *  - token WRONG  → 403, via a CONSTANT-TIME compare (no byte-by-byte timing).
 *
 * Before this fix `requireInternalToken` only enforced the token
 * `if (expectedToken)` and compared with `!==` — an unset env silently disabled
 * auth entirely. These tests drive the REAL Hono app end to end through a
 * `handleInternal`-wrapped route, so the gate is exercised exactly as in prod.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { app, timingSafeStringEqual } from "./index";

const ROUTE = "/api/v1/cron/deployment-monitor";
const HEADER = "x-container-control-plane-token";
const savedToken = process.env.CONTAINER_CONTROL_PLANE_TOKEN;

beforeEach(() => {
  delete process.env.CONTAINER_CONTROL_PLANE_TOKEN;
});
afterEach(() => {
  if (savedToken === undefined)
    delete process.env.CONTAINER_CONTROL_PLANE_TOKEN;
  else process.env.CONTAINER_CONTROL_PLANE_TOKEN = savedToken;
});

describe("requireInternalToken fails closed (H4)", () => {
  test("unset token → 503 for every mutation (fail-closed)", async () => {
    const res = await app.request(ROUTE, { method: "GET" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Control-plane token not configured");
  });

  test("unset token → 503 even when a token header is supplied", async () => {
    const res = await app.request(ROUTE, {
      method: "GET",
      headers: { [HEADER]: "anything" },
    });
    expect(res.status).toBe(503);
  });

  test("wrong token → 403", async () => {
    process.env.CONTAINER_CONTROL_PLANE_TOKEN = "the-real-secret";
    const res = await app.request(ROUTE, {
      method: "GET",
      headers: { [HEADER]: "not-the-secret" },
    });
    expect(res.status).toBe(403);
  });

  test("missing token header when configured → 403", async () => {
    process.env.CONTAINER_CONTROL_PLANE_TOKEN = "the-real-secret";
    const res = await app.request(ROUTE, { method: "GET" });
    expect(res.status).toBe(403);
  });

  test("a token that is a prefix of the real one → 403 (not a partial match)", async () => {
    process.env.CONTAINER_CONTROL_PLANE_TOKEN = "the-real-secret";
    const res = await app.request(ROUTE, {
      method: "GET",
      headers: { [HEADER]: "the-real" },
    });
    expect(res.status).toBe(403);
  });
});

describe("timingSafeStringEqual", () => {
  test("equal strings compare true", () => {
    expect(timingSafeStringEqual("abc123", "abc123")).toBe(true);
  });

  test("different strings compare false", () => {
    expect(timingSafeStringEqual("abc123", "abc124")).toBe(false);
  });

  test("length mismatch compares false without throwing", () => {
    // node's timingSafeEqual throws on unequal-length buffers; the wrapper must
    // guard that (returning false) instead of crashing.
    expect(timingSafeStringEqual("abc", "abcdef")).toBe(false);
    expect(timingSafeStringEqual("", "x")).toBe(false);
  });
});
