/** Exercises hosted Parallel search through the shared transport with deterministic HTTP responses. */
import { afterEach, describe, expect, it } from "bun:test";
import { executeKeylessMcpSearch } from "./keyless-search";

const envelope = (text: string) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ text }] } });

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("executeKeylessMcpSearch", () => {
  it("uses Parallel when it answers", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return new Response(envelope("parallel answer"), { status: 200 });
    }) as typeof fetch;

    const result = await executeKeylessMcpSearch("test query");
    expect(result).toEqual({ answer: "parallel answer", provider: "parallel" });
    expect(urls).toEqual(["https://search.parallel.ai/mcp"]);
  });

  it("preserves a search answer beyond the former 8000-character cap", async () => {
    const answer = `start-${"x".repeat(9_000)}-end`;
    globalThis.fetch = (async () =>
      new Response(envelope(answer), { status: 200 })) as typeof fetch;

    await expect(executeKeylessMcpSearch("test query")).resolves.toEqual({
      answer,
      provider: "parallel",
    });
  });

  it("rejects a failed Parallel call without sending the query to another provider", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return new Response("upstream error", { status: 502 });
    }) as typeof fetch;
    await expect(executeKeylessMcpSearch("test query")).rejects.toThrow(
      "Keyless web search failed",
    );
    expect(urls).toEqual(["https://search.parallel.ai/mcp"]);
  });

  it("preserves every text block in an SSE result", async () => {
    globalThis.fetch = (async () =>
      new Response(
        `data: ${JSON.stringify({ result: { content: [{ text: "first" }, { text: "second" }] } })}\n\n`,
      )) as typeof fetch;
    await expect(executeKeylessMcpSearch("test query")).resolves.toEqual({
      answer: "first\nsecond",
      provider: "parallel",
    });
  });

  it("throws when Parallel fails", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;

    await expect(executeKeylessMcpSearch("test query")).rejects.toThrow(
      "Keyless web search failed",
    );
  });
});
