/**
 * Health-probe semantics for the chroma e2e helpers (bun test).
 *
 * Regression guard for the "<500 means healthy" bug: the old probe hit `/`
 * and accepted ANY non-5xx response, so a 404-ing, half-booted, or entirely
 * wrong server counted as healthy and the suite ran against garbage.
 * Healthy means `/api/health` answers 2xx with `{ status: "ok" }`.
 *
 * Run: bun run test:unit (from tools/chroma)
 */
import { afterAll, describe, expect, test } from "bun:test";

type Mode = "ok" | "degraded" | "no-health-route" | "server-error";
let mode: Mode = "ok";

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/health") {
      if (mode === "ok") {
        return Response.json({
          status: "ok",
          timestamp: new Date().toISOString(),
          env: "test",
        });
      }
      if (mode === "degraded") return Response.json({ status: "degraded" });
      if (mode === "server-error")
        return new Response("boom", { status: 500 });
      return new Response("Not Found", { status: 404 });
    }
    // Root answers 200 like any half-booted or wrong frontend would.
    return new Response("<html>not the feed app</html>", {
      headers: { "Content-Type": "text/html" },
    });
  },
});

// BASE_URL is captured at module load, so set the env before importing.
process.env.PLAYWRIGHT_BASE_URL = `http://127.0.0.1:${server.port}`;
const { isServerHealthy, waitForServerHealthy } = await import(
  "./page-helpers"
);

let serverStopped = false;
afterAll(() => {
  if (!serverStopped) server.stop(true);
});

describe("isServerHealthy", () => {
  test("healthy when /api/health answers 200 with status ok", async () => {
    mode = "ok";
    expect(await isServerHealthy()).toBe(true);
  });

  test("unhealthy when /api/health is missing even though / serves 200", async () => {
    mode = "no-health-route";
    expect(await isServerHealthy()).toBe(false);
  });

  test("unhealthy when /api/health reports a non-ok status body", async () => {
    mode = "degraded";
    expect(await isServerHealthy()).toBe(false);
  });

  test("unhealthy when /api/health answers 5xx", async () => {
    mode = "server-error";
    expect(await isServerHealthy()).toBe(false);
  });
});

describe("waitForServerHealthy", () => {
  test("resolves true once the readiness endpoint is healthy", async () => {
    mode = "ok";
    expect(await waitForServerHealthy(2, 10)).toBe(true);
  });

  test("resolves false when the readiness endpoint never turns healthy", async () => {
    mode = "no-health-route";
    expect(await waitForServerHealthy(2, 10)).toBe(false);
  });

  test("resolves false when nothing is listening", async () => {
    server.stop(true);
    serverStopped = true;
    expect(await waitForServerHealthy(2, 10)).toBe(false);
  });
});
