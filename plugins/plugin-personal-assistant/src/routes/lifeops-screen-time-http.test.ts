/**
 * Exercises the mounted screen-time HTTP boundary with the real dispatcher and
 * runtime, proving invalid windows never reach storage and unknown paths fall
 * through to the host's 404 response.
 */
import { createServer, type Server } from "node:http";
import { AgentRuntime, createCharacter } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleLifeOpsRoutes } from "./lifeops-routes.js";

describe("screen-time HTTP validation and fallthrough", () => {
  let server: Server;
  let origin: string;
  let runtime: AgentRuntime;

  beforeAll(async () => {
    runtime = new AgentRuntime({
      character: createCharacter({ name: "Screen-time HTTP validation" }),
      disableBasicCapabilities: true,
      enableAutonomy: false,
      logLevel: "fatal",
    });
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      try {
        const handled = await handleLifeOpsRoutes({
          req,
          res,
          method: req.method ?? "GET",
          pathname: url.pathname,
          url,
          state: { runtime, adminEntityId: null },
          json(response, body, status = 200) {
            response.writeHead(status, { "Content-Type": "application/json" });
            response.end(JSON.stringify(body));
          },
          error(response, message, status = 400) {
            response.writeHead(status, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: message }));
          },
          async readJsonBody() {
            throw new Error("GET must not read a request body");
          },
          decodePathComponent: decodeURIComponent,
        });
        if (!handled) {
          res.writeHead(404);
          res.end("Not found");
        }
      } catch (error) {
        // error-policy:J1 The test HTTP boundary exposes unexpected failures.
        res.writeHead(500);
        res.end(String(error));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP port");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.stop();
  });

  it.each(["summary", "breakdown"])(
    "rejects oversized and non-ISO %s windows",
    async (route) => {
      for (const [since, until] of [
        ["2026-01-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"],
        ["January 1, 2026", "January 2, 2026"],
      ]) {
        const query = new URLSearchParams({ since, until });
        const response = await fetch(
          `${origin}/api/lifeops/screen-time/${route}?${query}`,
          { signal: AbortSignal.timeout(2000) },
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: expect.any(String),
        });
      }
    },
  );

  it("lets an unknown screen-time path reach the host fallback", async () => {
    const response = await fetch(`${origin}/api/lifeops/screen-time/unknown`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it.each(["0x10", "1e1"])("rejects non-decimal counts (%s)", async (topN) => {
    const query = new URLSearchParams({ topN });
    const response = await fetch(
      `${origin}/api/lifeops/screen-time/history?${query}`,
      { signal: AbortSignal.timeout(2000) },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
  });
});
