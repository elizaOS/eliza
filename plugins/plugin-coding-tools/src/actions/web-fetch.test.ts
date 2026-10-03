/**
 * WEB_FETCH coverage for the coding-tools plugin: planned admission, SSRF
 * rejection, redirect revalidation, byte caps, timeout/error surfacing, HTML
 * extraction, binary rejection, and stable success metadata. The HTTP layer is
 * injected so tests run without real DNS or network.
 */
import {
  type ActionParameters,
  type ActionResult,
  executePlannedToolCall,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetWebHttpTestOverrides,
  __setWebHttpFetchImplForTests,
  __setWebHttpLookupFnForTests,
  __setWebHttpPinnedFetchImplForTests,
} from "../lib/web-http.js";
import { htmlToReadableText, webFetchAction } from "./web-fetch.js";

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  const logger = {
    ...actual.logger,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return { ...actual, logger, createLogger: () => logger, elizaLogger: logger };
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

beforeEach(() => vi.stubEnv("ELIZA_WEB_FETCH", undefined));
afterEach(() => {
  __resetWebHttpTestOverrides();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("coding-tools WEB_FETCH", () => {
  it("records completion time without treating the upstream Date header as source freshness", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-17T17:19:38.000Z"));
    __setWebHttpLookupFnForTests(async () => [
      { address: PUBLIC_IP, family: 4 },
    ]);
    __setWebHttpPinnedFetchImplForTests(async () => {
      vi.setSystemTime(new Date("2026-09-17T17:19:41.000Z"));
      return new Response('{"price":42}', {
        headers: {
          "content-type": "application/json",
          date: "Wed, 16 Sep 2026 12:00:00 GMT",
        },
      });
    });

    const result = await runFetch({ url: "https://public.example.test/data" });
    expect(result.success).toBe(true);
    expect(result.text).toBe('{"price":42}');
    expect(result.data).toMatchObject({
      retrieved_at: "2026-09-17T17:19:41.000Z",
      retrieved_at_basis:
        "HTTP retrieval completed; not the source publication or market update time",
    });
  });

  it("names the alternative read tool after the guard's deadline aborts the request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let dispatched = 0;
    let timeoutSignal: AbortSignal | undefined;
    __setWebHttpLookupFnForTests(async () => [
      { address: "93.184.216.34", family: 4 },
    ]);
    __setWebHttpPinnedFetchImplForTests(async ({ init }) => {
      dispatched += 1;
      const signal = init.signal;
      if (!signal) throw new Error("Guard did not provide its deadline signal");
      timeoutSignal = signal;
      signal.throwIfAborted();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });
    const pending = runFetch({ url: "https://public.example.test/stalled" });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(dispatched).toBe(1);
    expect(timeoutSignal?.aborted).toBe(true);
    expect(timeoutSignal?.reason).toMatchObject({ name: "AbortError" });
    expect(result).toMatchObject({ success: false });
    expect(result?.text).toMatch(/aborted/iu);
    expect(result?.text).toContain("WEB_SEARCH");
  });

  it.each([
    ["web", "ADMIN", true],
    ["web", "USER", false],
    ["general", "ADMIN", false],
  ] as const)(
    "dispatches from %s as %s only when admitted",
    async (context, role, allowed) => {
      const fetch = vi.fn(async () => new Response("fetched"));
      __setWebHttpLookupFnForTests(async () => [
        { address: PUBLIC_IP, family: 4 },
      ]);
      __setWebHttpPinnedFetchImplForTests(fetch);
      const runtime = {
        agentId: "web-fetch-agent",
        actions: [webFetchAction],
        getRoom: async () => ({ worldId: "web-fetch-world" }),
        getWorld: async () => ({ metadata: { roles: { reader: role } } }),
        getEntityById: async () => null,
        getSetting: () => null,
        getService: () => null,
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      } as unknown as IAgentRuntime;
      const result = await executePlannedToolCall(
        runtime,
        {
          message: {
            entityId: "reader",
            roomId: "web-fetch",
            content: { text: "fetch a page" },
          } as Memory,
          activeContexts: [context],
          userRoles: [role],
        },
        {
          name: "WEB_FETCH",
          params: { url: "https://public.example.test/page" },
        },
      );
      expect(result.success, JSON.stringify(result)).toBe(allowed);
      expect(fetch).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (allowed) expect(result.text).toBe("fetched");
    },
  );

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

  it("rejects redirects that downgrade HTTPS to plaintext HTTP without requesting the plaintext hop", async () => {
    const requested: string[] = [];
    __setWebHttpLookupFnForTests(async () => [
      { address: PUBLIC_IP, family: 4 },
    ]);
    __setWebHttpPinnedFetchImplForTests(async ({ url }) => {
      requested.push(url.toString());
      if (url.toString() === "https://public.example.test/start") {
        return new Response("", {
          status: 302,
          headers: { location: "http://public.example.test/plaintext" },
        });
      }
      throw new Error(`unexpected request to ${url.toString()}`);
    });

    const result = await runFetch({ url: "https://public.example.test/start" });

    expect(result.success).toBe(false);
    expect(result.text).toContain("redirect downgrade");
    // The plaintext hop must be rejected BEFORE any request is issued to it.
    expect(requested).toEqual(["https://public.example.test/start"]);
  });

  it("honors the ELIZA_WEB_FETCH kill switch at validate and handler entry", async () => {
    vi.stubEnv("ELIZA_WEB_FETCH", "0");
    const fetch = vi.fn(async () => new Response("must not dispatch"));
    __setWebHttpFetchImplForTests(fetch);
    expect(
      await webFetchAction.validate(
        {} as IAgentRuntime,
        {} as Memory,
        {} as State,
      ),
    ).toBe(false);
    const result = await runFetch({ url: "https://public.example.test/x" });
    expect(result.success).toBe(false);
    expect(result.text).toContain("disabled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a response beyond the complete-capture ceiling without partial text", async () => {
    usePinnedRoutes({
      "https://public.example.test/large.txt": new Response(
        "x".repeat(300_000),
        { status: 200, headers: { "content-type": "text/plain" } },
      ),
    });

    const result = await runFetch({
      url: "https://public.example.test/large.txt",
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("safety ceiling");
    expect(result.text).not.toContain("x".repeat(100));
  });

  it.each([
    [
      "long response with a surrogate pair",
      `${"a".repeat(7_999)}🦊${"b".repeat(100)}`,
    ],
    ["trailing emoji", `${"a".repeat(100)}🦊`],
  ])("returns the complete well-formed %s", async (_label, text) => {
    usePinnedRoutes({
      "https://public.example.test/unicode": new Response(text, {
        headers: { "content-type": "text/plain" },
      }),
    });
    const result = await runFetch({
      url: "https://public.example.test/unicode",
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe(text);
    expect(result.text?.isWellFormed()).toBe(true);
  });

  it("names the WEB_SEARCH fallback on an upstream 5xx (live sweep: wttr.in HTTP 500)", async () => {
    usePinnedRoutes({
      "https://wttr.in/Austin,Texas?format=j1": new Response("boom", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    });
    const result = await runFetch({
      url: "https://wttr.in/Austin,Texas?format=j1",
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("HTTP 500");
    expect(result.text).toContain("wttr.in failed upstream");
    expect(result.text).toContain("WEB_SEARCH");
    expect(result.data).toMatchObject({ status: 500 });
  });

  it("carries no fallback hint on a plain 4xx", async () => {
    usePinnedRoutes({
      "https://public.example.test/missing": new Response("nope", {
        status: 404,
        headers: { "content-type": "text/plain" },
      }),
    });
    const result = await runFetch({
      url: "https://public.example.test/missing",
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("HTTP 404");
    expect(result.text).not.toContain("WEB_SEARCH");
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
    expect(result.text).toContain("WEB_SEARCH");
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

  it("rejects declared binary content types and cancels the rejected body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new TextEncoder().encode("binary bytes"));
      },
    });
    usePinnedRoutes({
      "https://public.example.test/image": new Response(body, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    });

    const result = await runFetch({ url: "https://public.example.test/image" });

    expect(result.success).toBe(false);
    expect(result.text).toContain("Unsupported content type");
    expect(cancelled).toBe(true);
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

  it("decodes valid numeric and named HTML entities in readable text", () => {
    expect(htmlToReadableText("<p>&#65; &#x41; &amp; &lt; &gt;</p>")).toBe(
      "A A & < >",
    );
    expect(htmlToReadableText("<p>&quot;&apos;&nbsp;x</p>")).toBe("\"' x");
  });

  it("removes browser-tokenized and unclosed script/style blocks", () => {
    expect(
      htmlToReadableText(
        "<p>visible</p><script>steal()</script:lookalike>still-script</sCrIpT data-x=1><style>hidden{}</style=lookalike>still-style</style/ignored><p>after</p><script>unclosed",
      ),
    ).toBe("visible\n\nafter");
  });

  it("degrades invalid numeric entities without throwing and keeps surrounding text", () => {
    // Invalid scalar values must remain literal instead of hard-failing the
    // fetch or introducing an unpaired UTF-16 surrogate into readable text.
    const hex = htmlToReadableText("<p>hello &#x110000; world</p>");
    expect(hex).toContain("hello");
    expect(hex).toContain("world");
    expect(hex).toContain("&#x110000;");

    const dec = htmlToReadableText("<p>hi &#1114112; there</p>");
    expect(dec).toContain("hi");
    expect(dec).toContain("there");
    expect(dec).toContain("&#1114112;");

    expect(htmlToReadableText("<p>&#xD800; &#55296;</p>")).toBe(
      "&#xD800; &#55296;",
    );
    expect(htmlToReadableText("<p>&#xDFFF; &#57343;</p>")).toBe(
      "&#xDFFF; &#57343;",
    );
  });

  it("degrades a malformed numeric entity to readable text through the handler instead of io_error", async () => {
    usePinnedRoutes({
      "https://public.example.test/bad-entity": new Response(
        "<html><body><p>alpha &#x110000; omega</p></body></html>",
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      ),
    });

    const result = await runFetch({
      url: "https://public.example.test/bad-entity",
    });

    // On unpatched develop htmlToReadableText throws RangeError, which the
    // handler surfaces as an io_error failure. The fix keeps the fetch success.
    expect(result.success).toBe(true);
    expect(result.text).toContain("alpha");
    expect(result.text).toContain("omega");
    expect(result.data).toMatchObject({ kind: "html" });
  });
});

describe("coding-tools WEB_FETCH extract bounds", () => {
  it("extracts a valid nested path", async () => {
    usePinnedRoutes({
      "https://public.example.test/bounded": new Response(
        JSON.stringify({ a: { b: { c: 123 } } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    });
    const result = await runFetch({
      url: "https://public.example.test/bounded",
      extract: "a.b.c",
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe("123");
  });

  const deep = Array.from({ length: 17 }, (_, index) => `k${index}`);
  const longPath = Array.from({ length: 5 }, () => "a".repeat(205));
  const longSegment = "x".repeat(257);
  const nestedBody = (segments: string[]) =>
    segments.reduceRight(
      (body, key) => `{${JSON.stringify(key)}:${body}}`,
      "42",
    );

  it.each([
    ["missing property", '{"data":{"price":42}}', "data.missing"],
    ["primitive parent", '{"a":1}', "a.missing"],
    ["empty segment", nestedBody(["a", "", "b"]), "a..b"],
    ["depth above 16", nestedBody(deep), deep.join(".")],
    ["segment above 256", nestedBody([longSegment]), longSegment],
    ["path above 1024", nestedBody(longPath), longPath.join(".")],
  ])("preserves full JSON for %s", async (_label, body, extract) => {
    usePinnedRoutes({
      "https://public.example.test/data": new Response(body, {
        headers: { "content-type": "application/json" },
      }),
    });
    const result = await runFetch({
      url: "https://public.example.test/data",
      extract,
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe(body);
  });

  it.each([
    ["application/json", '{"error": unclosed json string'],
    ["text/plain", "{ plain text starting with curly brace"],
  ])(
    "preserves malformed JSON-like %s as raw text",
    async (contentType, text) => {
      usePinnedRoutes({
        "https://public.example.test/malformed": new Response(text, {
          headers: { "content-type": contentType },
        }),
      });
      const result = await runFetch({
        url: "https://public.example.test/malformed",
      });
      expect(result.success).toBe(true);
      expect(result.text).toBe(text);
    },
  );
});
