/**
 * WEB_FETCH coverage for the coding-tools plugin: SSRF rejection, redirect
 * revalidation, byte caps, timeout/error surfacing, HTML extraction, binary
 * rejection, and stable success metadata. The HTTP layer is injected so tests
 * run without real DNS or network.
 */
import type {
  ActionParameters,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetWebHttpTestOverrides,
  __setWebHttpFetchImplForTests,
  __setWebHttpLookupFnForTests,
  __setWebHttpPinnedFetchImplForTests,
} from "../lib/web-http.js";
import { webFetchAction } from "./web-fetch.js";

vi.mock("@elizaos/logger", () => {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return {
    __loggerTestHooks: {},
    addLogListener: vi.fn(),
    createLogger: () => logger,
    customLevels: {},
    default: logger,
    elizaLogger: logger,
    logChatIn: vi.fn(),
    logChatOut: vi.fn(),
    logger,
    logPrompt: vi.fn(),
    logResponse: vi.fn(),
    recentLogs: [],
    removeLogListener: vi.fn(),
  };
});

const PUBLIC_IP = "93.184.216.34";

async function runFetch(parameters: ActionParameters): Promise<ActionResult> {
  const result = await webFetchAction.handler(
    {} as IAgentRuntime,
    {} as Memory,
    {} as State,
    { parameters },
  );
  if (!result) throw new Error("handler returned no result");
  return result;
}

function usePinnedRoutes(routes: Record<string, Response>): void {
  __setWebHttpLookupFnForTests(async (hostname) => {
    if (hostname === "private.example.test") {
      return [{ address: "10.0.0.7", family: 4 }];
    }
    return [{ address: PUBLIC_IP, family: 4 }];
  });
  __setWebHttpPinnedFetchImplForTests(async ({ url, init }) => {
    init.signal?.throwIfAborted();
    const response = routes[url.toString()];
    if (!response) throw new Error(`unhandled URL ${url.toString()}`);
    return response;
  });
}

describe("coding-tools WEB_FETCH", () => {
  afterEach(() => {
    __resetWebHttpTestOverrides();
  });

  it("rejects private literal IP targets before any request is sent", async () => {
    __setWebHttpFetchImplForTests(async () => {
      throw new Error("fetch should not run");
    });

    const result = await runFetch({ url: "https://10.0.0.1/metadata" });

    expect(result.success).toBe(false);
    expect(result.text).toContain("private");
  });

  it("rejects redirects to private-resolving hosts", async () => {
    usePinnedRoutes({
      "https://public.example.test/start": new Response("", {
        status: 302,
        headers: { location: "https://private.example.test/secret" },
      }),
    });

    const result = await runFetch({ url: "https://public.example.test/start" });

    expect(result.success).toBe(false);
    expect(result.text).toContain("private");
  });

  it("rejects redirects that downgrade HTTPS to plaintext HTTP", async () => {
    usePinnedRoutes({
      "https://public.example.test/start": new Response("", {
        status: 302,
        headers: { location: "http://public.example.test/plaintext" },
      }),
      "http://public.example.test/plaintext": new Response("unsafe", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    });

    const result = await runFetch({ url: "https://public.example.test/start" });

    expect(result.success).toBe(false);
    expect(result.text).toContain("redirect downgrade");
  });

  it("caps large text responses and marks metadata as truncated", async () => {
    usePinnedRoutes({
      "https://public.example.test/large.txt": new Response(
        "x".repeat(300_000),
        { status: 200, headers: { "content-type": "text/plain" } },
      ),
    });

    const result = await runFetch({
      url: "https://public.example.test/large.txt",
    });

    expect(result.success).toBe(true);
    expect((result.text ?? "").length).toBeLessThanOrEqual(8_012);
    expect(result.data).toMatchObject({
      action: "WEB_FETCH",
      status: 200,
      kind: "text",
      truncated: true,
    });
  });

  it("surfaces timeout-style fetch errors honestly", async () => {
    __setWebHttpLookupFnForTests(async () => [
      { address: PUBLIC_IP, family: 4 },
    ]);
    __setWebHttpPinnedFetchImplForTests(async () => {
      throw new Error("request aborted by timeout");
    });

    const result = await runFetch({ url: "https://public.example.test/slow" });

    expect(result.success).toBe(false);
    expect(result.text).toContain("request aborted by timeout");
  });

  it("extracts useful readable text from HTML instead of raw markup", async () => {
    usePinnedRoutes({
      "https://public.example.test/page": new Response(
        "<html><head><title>Docs &amp; API</title><style>.x{}</style></head><body><h1>Hello</h1><script>bad()</script><p>Readable <b>text</b>.</p></body></html>",
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      ),
    });

    const result = await runFetch({ url: "https://public.example.test/page" });

    expect(result.success).toBe(true);
    expect(result.text).toContain("Docs & API");
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("Readable text.");
    expect(result.text).not.toContain("<h1>");
    expect(result.text).not.toContain("bad()");
    expect(result.data).toMatchObject({ kind: "html" });
  });

  it("rejects declared binary content types", async () => {
    usePinnedRoutes({
      "https://public.example.test/image": new Response("not really an image", {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    });

    const result = await runFetch({ url: "https://public.example.test/image" });

    expect(result.success).toBe(false);
    expect(result.text).toContain("Unsupported content type");
  });

  it("extracts a JSON path and returns stable metadata", async () => {
    usePinnedRoutes({
      "https://public.example.test/data": new Response(
        JSON.stringify({ data: { price: 42 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    });

    const result = await runFetch({
      url: "https://public.example.test/data",
      extract: "data.price",
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("42");
    expect(result.data).toMatchObject({
      action: "WEB_FETCH",
      url: "https://public.example.test/data",
      final_url: "https://public.example.test/data",
      status: 200,
      kind: "json",
      truncated: false,
    });
  });

  it("reports a missing JSON extract path clearly", async () => {
    usePinnedRoutes({
      "https://public.example.test/data": new Response(
        JSON.stringify({ data: { price: 42 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    });

    const result = await runFetch({
      url: "https://public.example.test/data",
      extract: "data.missing",
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("JSON extract path not found: data.missing");
  });
});
