// Covers the keyless MCP search path: envelope/SSE parsing of tools/call
// responses and the Parallel → Exa fallback order. Deterministic — fetch is
// stubbed at the transport boundary; the parser and fallback logic under test
// run for real.
import { afterEach, describe, expect, it } from "bun:test";
import { executeKeylessMcpSearch, parseMcpResultText } from "./keyless-search";

const envelope = (text: string) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ text }] } });

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("parseMcpResultText", () => {
  it("parses a plain JSON-RPC envelope", () => {
    expect(parseMcpResultText(envelope("ranked results"))).toBe("ranked results");
  });

  it("parses an SSE stream of data: lines", () => {
    const body = `event: message\ndata: ${envelope("sse result")}\n\n`;
    expect(parseMcpResultText(body)).toBe("sse result");
  });

  it("returns undefined for an error envelope", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1 } });
    expect(parseMcpResultText(body)).toBeUndefined();
  });

  it("returns undefined for an isError tool result", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { isError: true, content: [{ text: "provider error" }] },
    });
    expect(parseMcpResultText(body)).toBeUndefined();
  });

  it("returns undefined for junk", () => {
    expect(parseMcpResultText("not json")).toBeUndefined();
    expect(parseMcpResultText("")).toBeUndefined();
  });
});

describe("executeKeylessMcpSearch", () => {
  it("uses Parallel when it answers", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return new Response(envelope("parallel answer"), { status: 200 });
    }) as typeof fetch;

    const result = await executeKeylessMcpSearch("test query", 5);
    expect(result).toEqual({ answer: "parallel answer", provider: "parallel" });
    expect(urls).toEqual(["https://search.parallel.ai/mcp"]);
  });

  it("falls back to Exa when Parallel fails", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      if (String(url).includes("parallel")) {
        return new Response("upstream error", { status: 502 });
      }
      return new Response(envelope("exa answer"), { status: 200 });
    }) as typeof fetch;

    const result = await executeKeylessMcpSearch("test query", 5);
    expect(result).toEqual({ answer: "exa answer", provider: "exa" });
    expect(urls).toEqual([
      "https://search.parallel.ai/mcp",
      "https://mcp.exa.ai/mcp",
    ]);
  });

  it("throws when both providers fail", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as typeof fetch;

    await expect(executeKeylessMcpSearch("test query", 5)).rejects.toThrow(
      "Keyless web search failed",
    );
  });
});
