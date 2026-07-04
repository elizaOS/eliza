import http from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AgentRuntime,
  Route,
  RouteRequest,
  RouteResponse,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPublicRuntimePluginRoute,
  tryHandleRuntimePluginRoute,
} from "./runtime-plugin-routes";

let servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeIdleConnections?.();
          server.closeAllConnections?.();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  servers = [];
});

function runtimeWithRoutes(routes: Route[]): AgentRuntime {
  return { routes } as AgentRuntime;
}

describe("isPublicRuntimePluginRoute", () => {
  it("recognizes webhook endpoints through public route declarations", () => {
    const runtime = runtimeWithRoutes([
      {
        type: "POST",
        path: "/api/whatsapp/webhook",
        public: true,
        name: "whatsapp-webhook",
        publicReason: "WhatsApp webhook callback is externally delivered.",
        publicWrite:
          "Inbound Meta webhook POST authenticated by the WhatsApp payload signature, not the local gate.",
      },
      {
        type: "POST",
        path: "/webhooks/bluebubbles",
        public: true,
        name: "bluebubbles-webhook",
        publicReason: "BlueBubbles webhook callback is externally delivered.",
        publicWrite:
          "Inbound BlueBubbles webhook POST authenticated by payload validation, not the local gate.",
      },
    ] as Route[]);

    expect(
      isPublicRuntimePluginRoute({
        runtime,
        method: "POST",
        pathname: "/api/whatsapp/webhook",
      }),
    ).toBe(true);
    expect(
      isPublicRuntimePluginRoute({
        runtime,
        method: "POST",
        pathname: "/webhooks/bluebubbles",
      }),
    ).toBe(true);
  });

  it("does not exempt matching webhook paths unless the route is public", () => {
    const runtime = runtimeWithRoutes([
      { type: "POST", path: "/api/whatsapp/webhook" },
      { type: "POST", path: "/webhooks/bluebubbles", public: false },
    ] as Route[]);

    expect(
      isPublicRuntimePluginRoute({
        runtime,
        method: "POST",
        pathname: "/api/whatsapp/webhook",
      }),
    ).toBe(false);
    expect(
      isPublicRuntimePluginRoute({
        runtime,
        method: "POST",
        pathname: "/webhooks/bluebubbles",
      }),
    ).toBe(false);
  });
});

async function startRouteServer(runtime: AgentRuntime): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      runtime,
      isAuthorized: () => true,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("tryHandleRuntimePluginRoute", () => {
  it("rejects public routes without declared auth intent before dispatch", () => {
    const runtime = {
      routes: [
        {
          type: "GET",
          path: "/plugin/public-without-intent",
          public: true,
          name: "public-without-intent",
          handler: async (_req: RouteRequest, res: RouteResponse) => {
            res.json({ reached: true });
          },
        },
      ],
    } as unknown as AgentRuntime;

    expect(() =>
      isPublicRuntimePluginRoute({
        runtime,
        method: "GET",
        pathname: "/plugin/public-without-intent",
      }),
    ).toThrow(/must declare publicReason/);
  });

  it("supports legacy handlers that call res.json directly", async () => {
    const runtime = {
      routes: [
        {
          type: "GET",
          path: "/plugin/direct-json",
          handler: async (_req: RouteRequest, res: RouteResponse) => {
            res.json({ ok: true });
          },
        },
      ],
    } as unknown as AgentRuntime;
    const baseUrl = await startRouteServer(runtime);

    const response = await fetch(`${baseUrl}/plugin/direct-json`);

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("supports status chaining for legacy handlers", async () => {
    const runtime = {
      routes: [
        {
          type: "POST",
          path: "/plugin/chained-json",
          handler: async (_req: RouteRequest, res: RouteResponse) => {
            res.status(201).json({ created: true });
          },
        },
      ],
    } as unknown as AgentRuntime;
    const baseUrl = await startRouteServer(runtime);

    const response = await fetch(`${baseUrl}/plugin/chained-json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });

    await expect(response.json()).resolves.toEqual({ created: true });
    expect(response.status).toBe(201);
  });

  it("supports legacy handlers that call res.send directly", async () => {
    const runtime = {
      routes: [
        {
          type: "GET",
          path: "/plugin/direct-send",
          handler: async (_req: RouteRequest, res: RouteResponse) => {
            res.send("plain response");
          },
        },
      ],
    } as unknown as AgentRuntime;
    const baseUrl = await startRouteServer(runtime);

    const response = await fetch(`${baseUrl}/plugin/direct-send`);

    await expect(response.text()).resolves.toBe("plain response");
    expect(response.status).toBe(200);
  });

  it("supports status chaining with res.send", async () => {
    const runtime = {
      routes: [
        {
          type: "GET",
          path: "/plugin/chained-send",
          handler: async (_req: RouteRequest, res: RouteResponse) => {
            res.status(202).send({ accepted: true });
          },
        },
      ],
    } as unknown as AgentRuntime;
    const baseUrl = await startRouteServer(runtime);

    const response = await fetch(`${baseUrl}/plugin/chained-send`);

    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("does not clobber existing Express-like response helpers", async () => {
    const runtime = {
      routes: [
        {
          type: "GET",
          path: "/plugin/custom-json",
          handler: async (_req: RouteRequest, res: RouteResponse) => {
            res.json({ ok: true });
          },
        },
      ],
    } as unknown as AgentRuntime;
    const server = http.createServer(async (req, res) => {
      const expressLike = res as typeof res & {
        json: (data: unknown) => typeof expressLike;
      };
      expressLike.json = (data: unknown) => {
        res.setHeader("X-Custom-Json", "preserved");
        res.setHeader("Content-Type", "application/vnd.test+json");
        res.end(JSON.stringify({ wrapped: data }));
        return expressLike;
      };

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const handled = await tryHandleRuntimePluginRoute({
        req,
        res,
        method: req.method ?? "GET",
        pathname: url.pathname,
        url,
        runtime,
        isAuthorized: () => true,
      });
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.end("not found");
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/plugin/custom-json`,
    );

    await expect(response.json()).resolves.toEqual({
      wrapped: { ok: true },
    });
    expect(response.headers.get("x-custom-json")).toBe("preserved");
    expect(response.headers.get("content-type")).toContain(
      "application/vnd.test+json",
    );
  });
});
