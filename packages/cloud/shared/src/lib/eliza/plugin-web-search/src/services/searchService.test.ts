// Covers the WebSearchService keyless path: initialize no longer throws
// without a Google key, and search() serves the keyless MCP answer. fetch is
// stubbed at the transport boundary; the service and keyless module run real.
import { afterEach, describe, expect, it } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import { WebSearchService } from "./searchService";

const envelope = (text: string) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ text }] } });

const keylessRuntime = {
  getSetting: () => null,
} as unknown as IAgentRuntime;

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("WebSearchService without a Google key", () => {
  it("starts instead of throwing", async () => {
    const service = await WebSearchService.start(keylessRuntime);
    expect(service).toBeInstanceOf(WebSearchService);
    expect(service.capabilityDescription).toContain("keyless");
  });

  it("serves the keyless MCP answer through search()", async () => {
    globalThis.fetch = (async () =>
      new Response(envelope("ranked keyless results"), {
        status: 200,
      })) as typeof fetch;

    const service = await WebSearchService.start(keylessRuntime);
    const response = await service.search("current eth price", {
      max_results: 3,
    });

    expect(response.answer).toBe("ranked keyless results");
    expect(response.provider).toBe("parallel");
    expect(response.query).toBe("current eth price");
    expect(response.results).toEqual([]);
    expect(response.responseTime).toBeGreaterThanOrEqual(0);
  });

  it("surfaces a real error when every keyless provider fails", async () => {
    globalThis.fetch = (async () => new Response("down", { status: 500 })) as typeof fetch;

    const service = await WebSearchService.start(keylessRuntime);
    await expect(service.search("anything")).rejects.toThrow("Keyless web search failed");
  });
});
