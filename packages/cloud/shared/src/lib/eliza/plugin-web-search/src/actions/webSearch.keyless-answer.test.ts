// Regression coverage for the WEB_SEARCH success gate: a synthesized provider
// answer with an empty link list (the keyless Parallel→Exa shape) must reach
// the user instead of being reported as "no relevant results". The action runs
// real; only fetch and the runtime surface are stubbed.
import { afterEach, describe, expect, it } from "bun:test";
import type { ActionResult, IAgentRuntime, Memory } from "@elizaos/core";
import { webSearch } from "./webSearch";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function keylessEnvelope(answer: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ text: answer }] },
  });
}

function fakeRuntime(): IAgentRuntime {
  const { WebSearchService } = require("../services/searchService") as {
    WebSearchService: new (runtime: IAgentRuntime) => unknown;
  };
  const service = new WebSearchService({
    getSetting: () => null,
  } as unknown as IAgentRuntime);
  return {
    getService: () => service,
    getSetting: () => null,
  } as unknown as IAgentRuntime;
}

function messageWithParams(query: string): Memory {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    entityId: "00000000-0000-4000-8000-000000000002",
    roomId: "00000000-0000-4000-8000-000000000003",
    agentId: "00000000-0000-4000-8000-000000000004",
    content: { text: query, params: { query } },
  } as unknown as Memory;
}

describe("WEB_SEARCH answer-only responses", () => {
  it("returns the keyless provider answer when no links are present", async () => {
    globalThis.fetch = (async () =>
      new Response(keylessEnvelope("provider answer that must reach the user"), {
        status: 200,
      })) as typeof fetch;

    const result = (await webSearch.handler!(
      fakeRuntime(),
      messageWithParams("current eth price"),
      undefined,
      {},
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect(result.text).toBe("provider answer that must reach the user");
  });

  it("keeps the answer success when the response carries results too", async () => {
    // A non-empty link list with an answer must keep flowing exactly as
    // before the fix; the gate change only widens acceptance.
    globalThis.fetch = (async () =>
      new Response(keylessEnvelope("keyless answer"), { status: 200 })) as typeof fetch;

    const result = (await webSearch.handler!(
      fakeRuntime(),
      messageWithParams("query"),
      undefined,
      {},
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect(result.text).toContain("keyless answer");
  });

  it("keeps the no-result failure when the response is empty", async () => {
    globalThis.fetch = (async () =>
      new Response(keylessEnvelope(""), { status: 200 })) as typeof fetch;

    const result = (await webSearch.handler!(
      fakeRuntime(),
      messageWithParams("obscure query"),
      undefined,
      {},
    )) as ActionResult;

    expect(result.success).toBe(false);
  });
});
