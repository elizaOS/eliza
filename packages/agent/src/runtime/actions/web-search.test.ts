/**
 * Behavioral tests for the WEB_SEARCH action: inline-vs-server capability
 * gating, provider fallback (parallel → exa), JSON-RPC and SSE response
 * parsing, error-envelope rejection, and result-length capping. Deterministic —
 * DNS and the pinned fetch to each MCP endpoint are stubbed, so no real network.
 */
import type {
  ActionParameters,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  __setDnsLookupImplForTests,
  __setPinnedFetchImplForTests,
} from "../custom-actions.ts";
import { webSearch } from "./web-search.ts";

// A public IP so resolveUrlSafety skips real DNS and hits the pinned-fetch
// impl, which we mock — no real network for either MCP endpoint.
const PUBLIC_IP = "93.184.216.34";

const mcpJson = (text: string): string =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text }] },
  });
const mcpSse = (text: string): string =>
  `event: message\ndata: ${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text }] },
  })}\n\n`;
const mcpErrorEnvelope = (message: string): string =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message } });
const mcpToolError = (text: string): string =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { isError: true, content: [{ type: "text", text }] },
  });

/**
 * Route each provider's mocked body by hostname (parallel vs exa). A missing
 * key returns HTTP 500 so the action treats that provider as failed.
 */
function mockProviders(byHost: { parallel?: string; exa?: string }): void {
  __setDnsLookupImplForTests(async () => [{ address: PUBLIC_IP, family: 4 }]);
  __setPinnedFetchImplForTests(async ({ url }) => {
    const host = (url as URL).hostname;
    if (host.includes("parallel")) {
      return new Response(byHost.parallel ?? "", {
        status: byHost.parallel === undefined ? 500 : 200,
      });
    }
    if (host.includes("exa")) {
      return new Response(byHost.exa ?? "", {
        status: byHost.exa === undefined ? 500 : 200,
      });
    }
    return new Response("", { status: 404 });
  });
}

async function runHandler(parameters: ActionParameters): Promise<{
  result: ActionResult;
  captured: { text?: string };
}> {
  const captured: { text?: string } = {};
  const result = await webSearch.handler(
    {} as IAgentRuntime,
    {} as Memory,
    {} as State,
    { parameters },
    (content) => {
      captured.text = content.text;
      return Promise.resolve([]);
    },
  );
  if (!result) throw new Error("handler returned no result");
  return { result, captured };
}

describe("WEB_SEARCH action", () => {
  const original = process.env.ELIZA_WEB_SEARCH;
  const originalInline = process.env.ELIZA_INLINE_WEB_SEARCH;
  const originalServer = process.env.ELIZA_SERVER_WEB_SEARCH;

  afterEach(() => {
    __setPinnedFetchImplForTests(null);
    __setDnsLookupImplForTests(null);
    if (original === undefined) delete process.env.ELIZA_WEB_SEARCH;
    else process.env.ELIZA_WEB_SEARCH = original;
    if (originalInline === undefined)
      delete process.env.ELIZA_INLINE_WEB_SEARCH;
    else process.env.ELIZA_INLINE_WEB_SEARCH = originalInline;
    if (originalServer === undefined)
      delete process.env.ELIZA_SERVER_WEB_SEARCH;
    else process.env.ELIZA_SERVER_WEB_SEARCH = originalServer;
  });

  it("is available by default through the inline action surface", async () => {
    delete process.env.ELIZA_WEB_SEARCH;
    delete process.env.ELIZA_INLINE_WEB_SEARCH;
    delete process.env.ELIZA_SERVER_WEB_SEARCH;
    expect(await webSearch.validate({} as IAgentRuntime, {} as Memory)).toBe(
      true,
    );
  });

  it("is disabled by default when provider-native server search is explicitly enabled", async () => {
    delete process.env.ELIZA_INLINE_WEB_SEARCH;
    process.env.ELIZA_SERVER_WEB_SEARCH = "1";
    expect(await webSearch.validate({} as IAgentRuntime, {} as Memory)).toBe(
      false,
    );
  });

  it("honors an explicit inline search override", async () => {
    process.env.ELIZA_SERVER_WEB_SEARCH = "1";
    process.env.ELIZA_INLINE_WEB_SEARCH = "1";
    expect(await webSearch.validate({} as IAgentRuntime, {} as Memory)).toBe(
      true,
    );
  });

  it("is gated off when ELIZA_WEB_SEARCH disables all web-search surfaces", async () => {
    process.env.ELIZA_INLINE_WEB_SEARCH = "1";
    process.env.ELIZA_SERVER_WEB_SEARCH = "1";
    for (const value of ["0", "false", "off"]) {
      process.env.ELIZA_WEB_SEARCH = value;
      expect(await webSearch.validate({} as IAgentRuntime, {} as Memory)).toBe(
        false,
      );
    }
  });

  it("fails clearly when no query is given", async () => {
    const { result } = await runHandler({});
    expect(result.success).toBe(false);
    expect(result.text).toContain("query");
  });

  it("returns parsed results from a JSON-RPC response (parallel)", async () => {
    mockProviders({ parallel: mcpJson("RESULT: best ramen — Tabelog") });
    const { result, captured } = await runHandler({ query: "ramen" });
    expect(result.success).toBe(true);
    expect(result.text).toContain("Tabelog");
    expect(captured.text).toContain("Tabelog");
    expect(result.data).toMatchObject({
      actionName: "WEB_SEARCH",
      provider: "parallel",
    });
  });

  it("parses an SSE 'data:' framed response (exa)", async () => {
    mockProviders({ parallel: mcpJson(""), exa: mcpSse("EXA: top result") });
    const { result } = await runHandler({ query: "x" });
    expect(result.success).toBe(true);
    expect(result.text).toContain("EXA: top result");
    expect(result.data).toMatchObject({ provider: "exa" });
  });

  it("treats a JSON-RPC error envelope as failure, never a result", async () => {
    mockProviders({
      parallel: mcpErrorEnvelope("invalid params"),
      exa: mcpErrorEnvelope("invalid params"),
    });
    const { result } = await runHandler({ query: "x" });
    expect(result.success).toBe(false);
    expect(result.text).toContain("No web search results");
    // the error text must NOT be handed to the model as if it were results
    expect(result.text).not.toContain("invalid params");
  });

  it("treats result.isError as failure, never a result", async () => {
    mockProviders({
      parallel: mcpToolError("rate limited, try later"),
      exa: mcpToolError("rate limited, try later"),
    });
    const { result } = await runHandler({ query: "x" });
    expect(result.success).toBe(false);
    expect(result.text).not.toContain("rate limited");
  });

  it("falls back to exa when parallel returns no usable content", async () => {
    mockProviders({ parallel: mcpJson(""), exa: mcpJson("EXA-ANSWER") });
    const { result } = await runHandler({ query: "x" });
    expect(result.success).toBe(true);
    expect(result.text).toContain("EXA-ANSWER");
    expect(result.data).toMatchObject({ provider: "exa" });
  });

  it("caps the result text handed back to the model", async () => {
    mockProviders({ parallel: mcpJson("y".repeat(20_000)) });
    const { result } = await runHandler({ query: "x" });
    expect(result.success).toBe(true);
    expect((result.text ?? "").length).toBe(4_000);
  });
});
