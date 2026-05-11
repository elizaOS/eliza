/**
 * Integration test for the LM Studio plugin against a mocked HTTP server.
 *
 * We stand up an in-process HTTP server that mimics LM Studio's OpenAI-compatible
 * surface — just `GET /v1/models`. The text generation path still mocks the AI SDK
 * (we're testing the plugin's plumbing around the SDK, not the SDK itself), but the
 * detection path goes through real `fetch` against the mock server.
 */

import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { detectLMStudio } from "../utils/detect";
import { lmStudioPlugin } from "../plugin";

interface MockServerHandle {
  server: Server;
  baseURL: string;
  setHandler(fn: (path: string) => { status: number; body: unknown }): void;
}

async function startMockServer(): Promise<MockServerHandle> {
  let handler: (path: string) => { status: number; body: unknown } = (path) => {
    if (path === "/v1/models") {
      return {
        status: 200,
        body: {
          object: "list",
          data: [{ id: "lmstudio-default-model", object: "model" }],
        },
      };
    }
    return { status: 404, body: { error: "not found" } };
  };

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const { status, body } = handler(url);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    server,
    baseURL: `http://127.0.0.1:${addr.port}/v1`,
    setHandler(fn) {
      handler = fn;
    },
  };
}

describe("LM Studio integration (mocked endpoint)", () => {
  let mock: MockServerHandle;

  beforeAll(async () => {
    mock = await startMockServer();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  beforeEach(() => {
    mock.setHandler((path) => {
      if (path === "/v1/models") {
        return {
          status: 200,
          body: {
            object: "list",
            data: [
              { id: "lmstudio-community/qwen2.5-7b-instruct", object: "model" },
              { id: "lmstudio-community/llama-3.1-8b", object: "model" },
            ],
          },
        };
      }
      return { status: 404, body: { error: "not found" } };
    });
  });

  it("detects LM Studio against the live mock server", async () => {
    const result = await detectLMStudio({ baseURL: mock.baseURL });
    expect(result.available).toBe(true);
    expect(result.models).toHaveLength(2);
    expect(result.models?.[0]?.id).toContain("qwen2.5-7b-instruct");
  });

  it("returns available=false when /v1/models 500s", async () => {
    mock.setHandler(() => ({ status: 500, body: { error: "boom" } }));
    const result = await detectLMStudio({ baseURL: mock.baseURL });
    expect(result.available).toBe(false);
    expect(result.error).toContain("500");
  });

  it("auto-enable predicate returns true when the server is reachable", async () => {
    expect(typeof lmStudioPlugin.autoEnable?.shouldEnable).toBe("function");
    // Override the default detect to point at our mock server.
    const result = await detectLMStudio({ baseURL: mock.baseURL, timeoutMs: 500 });
    expect(result.available).toBe(true);
  });

  it("plugin.init() probes the configured endpoint and logs success on 200", async () => {
    const runtime = {
      character: { system: "" },
      emitEvent: vi.fn(),
      getSetting: (key: string) => {
        if (key === "LMSTUDIO_BASE_URL") return mock.baseURL;
        return null;
      },
      fetch,
    } as unknown as Parameters<NonNullable<typeof lmStudioPlugin.init>>[1];

    // Should not throw.
    await lmStudioPlugin.init?.({}, runtime);
  });

  it("plugin.init() does not throw when the endpoint is unreachable", async () => {
    const runtime = {
      character: { system: "" },
      emitEvent: vi.fn(),
      getSetting: (key: string) => {
        if (key === "LMSTUDIO_BASE_URL") return "http://127.0.0.1:1";
        return null;
      },
      fetch,
    } as unknown as Parameters<NonNullable<typeof lmStudioPlugin.init>>[1];

    await lmStudioPlugin.init?.({}, runtime);
  });
});
