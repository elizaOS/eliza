import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { webFetchHandler } from "./web-fetch.js";

interface RouteResponse {
  status?: number;
  contentType?: string;
  body?: string | Buffer;
}

const routes = new Map<string, RouteResponse>();
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const route = routes.get(req.url ?? "/");
    if (!route) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = route.status ?? 200;
    if (route.contentType) {
      res.setHeader("content-type", route.contentType);
    }
    res.end(route.body ?? "");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function makeRuntime(settings: Record<string, unknown> = {}): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
  } as IAgentRuntime;
}

const message = {} as Memory;
const state: State | undefined = undefined;

describe("WEB_FETCH", () => {
  it("rejects non-http(s) URLs as invalid_param", async () => {
    const runtime = makeRuntime({ CODING_TOOLS_WEB_FETCH_ALLOW_LOOPBACK: "1" });
    const result = await webFetchHandler(runtime, message, state, {
      parameters: { url: "ftp://example.com/foo" },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
  });

  it("rejects malformed URLs as invalid_param", async () => {
    const runtime = makeRuntime({ CODING_TOOLS_WEB_FETCH_ALLOW_LOOPBACK: "1" });
    const result = await webFetchHandler(runtime, message, state, {
      parameters: { url: "not a url" },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
  });

  it("rejects loopback by default", async () => {
    const runtime = makeRuntime();
    const result = await webFetchHandler(runtime, message, state, {
      parameters: { url: `${baseUrl}/` },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("path_blocked");
  });

  it("strips HTML tags and returns plain text", async () => {
    routes.set("/html", {
      contentType: "text/html; charset=utf-8",
      body: "<html><head><style>body{color:red}</style><script>alert(1)</script></head><body><h1>Hello</h1><p>World <b>bold</b></p></body></html>",
    });
    const runtime = makeRuntime({ CODING_TOOLS_WEB_FETCH_ALLOW_LOOPBACK: "1" });
    const result = await webFetchHandler(runtime, message, state, {
      parameters: { url: `${baseUrl}/html`, prompt: "summarize" },
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("Hello World bold");
    expect(result.text).not.toContain("<");
    expect(result.text).not.toContain("alert(1)");
    expect(result.text).not.toContain("color:red");
    expect(result.text).toContain("Prompt: summarize");
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.contentType).toContain("text/html");
    expect(data?.truncated).toBe(false);
    expect(typeof data?.byteCount).toBe("number");
  });

  it("returns non-HTML content as-is", async () => {
    routes.set("/plain", {
      contentType: "text/plain; charset=utf-8",
      body: "hello <not stripped> world",
    });
    const runtime = makeRuntime({ CODING_TOOLS_WEB_FETCH_ALLOW_LOOPBACK: "1" });
    const result = await webFetchHandler(runtime, message, state, {
      parameters: { url: `${baseUrl}/plain` },
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("hello <not stripped> world");
  });

  it("fails on 5xx responses", async () => {
    routes.set("/boom", { status: 500, body: "server error" });
    const runtime = makeRuntime({ CODING_TOOLS_WEB_FETCH_ALLOW_LOOPBACK: "1" });
    const result = await webFetchHandler(runtime, message, state, {
      parameters: { url: `${baseUrl}/boom` },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("io_error");
    expect(result.text).toContain("500");
  });

  it("fails on missing url param", async () => {
    const runtime = makeRuntime({ CODING_TOOLS_WEB_FETCH_ALLOW_LOOPBACK: "1" });
    const result = await webFetchHandler(runtime, message, state, {
      parameters: {},
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });
});
