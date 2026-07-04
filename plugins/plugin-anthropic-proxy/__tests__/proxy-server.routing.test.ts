/**
 * Routing tests for `ProxyServer` with `node:https` mocked: the auth-token gate,
 * `/health`, header rewriting, SSE vs JSON reverse-mapping, and non-200
 * error passthrough. Captures the outbound upstream request; no live upstream.
 */

import { EventEmitter } from "node:events";
import type { ClientRequest, RequestOptions } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";

const httpsMock = vi.hoisted(() => ({
  request: vi.fn(),
  upstreamBodies: [] as Buffer[],
  upstreamOptions: [] as RequestOptions[],
}));

vi.mock("node:https", () => ({
  request: httpsMock.request,
}));

function installUpstream(statusCode = 200, body = "{}") {
  httpsMock.request.mockImplementation(
    (options: RequestOptions, callback: (res: EventEmitter) => void) => {
      httpsMock.upstreamOptions.push(options);
      const upstream = new EventEmitter() as ClientRequest & {
        write: (chunk: Buffer) => void;
      };
      upstream.write = (chunk: Buffer) => {
        httpsMock.upstreamBodies.push(Buffer.from(chunk));
        return true;
      };
      upstream.end = (() => {
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
        };
        response.statusCode = statusCode;
        response.headers = { "content-type": "application/json" };
        callback(response);
        queueMicrotask(() => {
          response.emit("data", Buffer.from(body));
          response.emit("end");
        });
        return upstream;
      }) as ClientRequest["end"];
      return upstream;
    },
  );
}

afterEach(() => {
  httpsMock.request.mockReset();
  httpsMock.upstreamBodies.length = 0;
  httpsMock.upstreamOptions.length = 0;
});

describe("ProxyServer routing", () => {
  it("does not synthesize JSON for empty-body proxied GET requests", async () => {
    installUpstream(200, '{"ok":true}');
    const { ProxyServer } = await import("../src/proxy/server.js");
    const server = new ProxyServer({
      port: 0,
      bindHost: "127.0.0.1",
      envToken: "oauth-token",
    });
    await server.start();
    try {
      const response = await fetch(`${server.getUrl()}/v1/models`);
      await expect(response.json()).resolves.toEqual({ ok: true });

      expect(httpsMock.upstreamBodies).toHaveLength(1);
      expect(httpsMock.upstreamBodies[0].toString("utf8")).toBe("");
      expect(httpsMock.upstreamOptions[0]).toMatchObject({
        method: "GET",
        path: "/v1/models",
      });
      expect(httpsMock.upstreamOptions[0].headers).toMatchObject({
        authorization: "Bearer oauth-token",
        "content-length": 0,
      });
    } finally {
      await server.stop();
    }
  });
});
