import { AgentRuntime } from "@elizaos/core";
import { registerHttpPluginRoutes } from "@elizaos/host/protocol";
import { expect, test } from "vitest";
import { startScenarioApiServer } from "./executor.ts";

test("scenario HTTP server serves migrated and legacy plugin routes through real sockets", async () => {
  const runtime = new AgentRuntime({
    character: { name: "Scenario route fixture" },
    logLevel: "fatal",
  });
  registerHttpPluginRoutes(runtime, {
    name: "scenario-route-fixture",
    description: "Local HTTP contract fixture",
    routes: [
      {
        type: "GET",
        path: "/api/legacy",
        rawPath: true,
        handler: async (_req, res) => {
          res.json({ legacy: true });
        },
      },
      {
        type: "POST",
        path: "/api/modern/:id",
        rawPath: true,
        maxBodyBytes: 32,
        routeHandler: async (ctx) => ({
          status: 201,
          headers: { "x-fixture": "modern" },
          body: {
            id: ctx.params.id,
            body: ctx.body,
            trustedLocal: ctx.isTrustedLocal,
            aborted: ctx.signal.aborted,
          },
        }),
      },
      {
        type: "GET",
        path: "/api/text",
        rawPath: true,
        routeHandler: async () => ({ status: 200, body: "plain response" }),
      },
    ],
  });
  const server = await startScenarioApiServer(runtime);
  try {
    expect(await (await fetch(`${server.baseUrl}/api/legacy`)).json()).toEqual({
      legacy: true,
    });
    const response = await fetch(`${server.baseUrl}/api/modern/item`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "yes" }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-fixture")).toBe("modern");
    expect(await response.json()).toEqual({
      id: "item",
      body: { value: "yes" },
      trustedLocal: true,
      aborted: false,
    });
    const text = await fetch(`${server.baseUrl}/api/text`);
    expect(text.headers.get("content-type")).toContain("text/plain");
    expect(await text.text()).toBe("plain response");
    const oversized = await fetch(`${server.baseUrl}/api/modern/item`, {
      method: "POST",
      body: "x".repeat(33),
    });
    expect(oversized.status).toBe(413);
    await oversized.text();
    const missing = await fetch(`${server.baseUrl}/api/missing`);
    expect(missing.status).toBe(404);
    await missing.text();
  } finally {
    await server.close();
  }
});
