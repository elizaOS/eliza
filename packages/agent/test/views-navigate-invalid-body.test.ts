/** Rejected navigate bodies and the UI-language header, over real loopback HTTP. */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readUiLanguageHeader } from "../src/api/server-helpers-config.ts";
import {
  closeRuntimeViewRegistry,
  registerBuiltinViews,
} from "../src/api/views-registry.ts";
import { handleViewsRoutes } from "../src/api/views-routes.ts";

const owner = "11111111-1111-4111-8111-111111111111" as UUID;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function fixture() {
  const emitEvent = vi.fn(async () => undefined);
  const broadcastWs = vi.fn();
  const handlerResponses: number[] = [];
  const runtime = {
    agentId: "44444444-4444-4444-8444-444444444444",
    getSetting: () => undefined,
    emitEvent,
    reportError: vi.fn(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as IAgentRuntime;
  registerBuiltinViews(runtime);
  const hostKey = {};
  const settled: Array<Promise<unknown>> = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    settled.push(
      handleViewsRoutes({
        req,
        res,
        method: req.method ?? "GET",
        pathname: url.pathname,
        url,
        hostKey,
        runtime,
        callerAuthorization: { ok: true, role: "OWNER", identityId: owner },
        json: (response, body) => {
          handlerResponses.push(200);
          if (response.headersSent) return;
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(body));
        },
        error: (response, message, code = 500) => {
          handlerResponses.push(code);
          if (response.headersSent) return;
          response.writeHead(code, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: message }));
        },
        broadcastWs,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  cleanup.push(async () => {
    closeRuntimeViewRegistry(runtime);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    port,
    emitEvent,
    broadcastWs,
    handlerResponses,
    settle: () => Promise.all(settled),
  };
}

describe("POST /api/views/:id/navigate with an invalid body", () => {
  it("returns the 400 without broadcasting, committing, or responding again", async () => {
    const { port, emitEvent, broadcastWs, handlerResponses, settle } =
      await fixture();
    const response = await fetch(
      `http://127.0.0.1:${port}/api/views/__view-manager__/navigate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid JSON in request body",
    });
    await settle();
    expect(broadcastWs).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
    expect(handlerResponses).toEqual([]);

    const current = await fetch(
      `http://127.0.0.1:${port}/api/views/current`,
    ).then((res) => res.json());
    expect(current).not.toMatchObject({ viewId: "__view-manager__" });
  });

  it("still navigates a valid body", async () => {
    const { port, broadcastWs, settle } = await fixture();
    const response = await fetch(
      `http://127.0.0.1:${port}/api/views/__view-manager__/navigate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
    await settle();
    expect(broadcastWs).toHaveBeenCalledTimes(1);
  });
});

describe("readUiLanguageHeader", () => {
  const request = (headers: Record<string, string>) =>
    ({ headers }) as unknown as IncomingMessage;

  it("reads the X-ElizaOS-UI-Language header the UI client sends", () => {
    expect(
      readUiLanguageHeader(request({ "x-elizaos-ui-language": "ja" })),
    ).toBe("ja");
  });

  it("falls back to the legacy X-Eliza-UI-Language header", () => {
    expect(
      readUiLanguageHeader(request({ "x-eliza-ui-language": " ko " })),
    ).toBe("ko");
  });

  it("prefers X-ElizaOS-UI-Language when both are present", () => {
    expect(
      readUiLanguageHeader(
        request({ "x-elizaos-ui-language": "es", "x-eliza-ui-language": "fr" }),
      ),
    ).toBe("es");
  });
});
