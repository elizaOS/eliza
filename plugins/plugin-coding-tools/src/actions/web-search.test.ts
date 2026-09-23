/**
 * WEB_SEARCH coverage for planned admission, Parallel/Exa results, complete
 * model-facing output, and disabled-action denial. The shared transport fetch is stubbed for every provider.
 */
import {
  type ActionParameters,
  type ActionResult,
  executePlannedToolCall,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webSearchAction } from "./web-search.js";

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

function mockSearchProviders(byHost: {
  parallel?: string;
  exa?: string;
}): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const host = new URL(String(input)).hostname;
    if (host.includes("parallel")) {
      return new Response(byHost.parallel ?? "", {
        status: byHost.parallel === undefined ? 500 : 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (host.includes("exa")) {
      return new Response(byHost.exa ?? "", {
        status: byHost.exa === undefined ? 500 : 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("", { status: 404 });
  });
}

async function runSearch(parameters: ActionParameters): Promise<ActionResult> {
  const result = await webSearchAction.handler(
    {} as IAgentRuntime,
    {} as Memory,
    {} as State,
    { parameters },
  );
  if (!result) throw new Error("handler returned no result");
  return result;
}

describe("coding-tools WEB_SEARCH", () => {
  beforeEach(() => {
    vi.stubEnv("ELIZA_WEB_SEARCH", undefined);
    vi.stubEnv("ELIZA_INLINE_WEB_SEARCH", undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    ["web", "ADMIN", true],
    ["web", "USER", false],
    ["general", "ADMIN", false],
  ] as const)(
    "dispatches from %s as %s only when admitted",
    async (context, role, allowed) => {
      const fetch = vi.fn(async () => new Response(mcpJson("Parallel result")));
      vi.stubGlobal("fetch", fetch);
      const runtime = {
        agentId: "search-agent",
        actions: [webSearchAction],
        getRoom: async () => ({ worldId: "search-world" }),
        getWorld: async () => ({ metadata: { roles: { reader: role } } }),
        getEntityById: async () => null,
        getSetting: () => null,
        getService: () => null,
        logger,
      } as unknown as IAgentRuntime;
      const result = await executePlannedToolCall(
        runtime,
        {
          message: {
            entityId: "reader",
            roomId: "search-room",
            content: { text: "search the web" },
          } as Memory,
          activeContexts: [context],
          userRoles: [role],
        },
        { name: "WEB_SEARCH", params: { query: "elizaOS latest" } },
      );
      expect(result.success, JSON.stringify(result)).toBe(allowed);
      expect(fetch).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (allowed) {
        expect(result.text).toBe("Parallel result");
        expect(result.data).toMatchObject({
          action: "WEB_SEARCH",
          provider: "parallel",
          truncated: false,
        });
      }
    },
  );

  it("falls back to Exa when Parallel has no usable result", async () => {
    mockSearchProviders({
      parallel: mcpJson(""),
      exa: mcpSse("Exa fallback result"),
    });

    const result = await runSearch({ query: "fallback query" });

    expect(result.success).toBe(true);
    expect(result.text).toContain("Exa fallback result");
    expect(result.data).toMatchObject({ provider: "exa" });
  });

  it("returns complete provider output to the model", async () => {
    mockSearchProviders({ parallel: mcpJson("y".repeat(20_000)) });

    const result = await runSearch({ query: "large result" });

    expect(result.success).toBe(true);
    expect(result.text).toBe("y".repeat(20_000));
    expect(result.data).toMatchObject({
      provider: "parallel",
      truncated: false,
    });
  });

  it("returns a clear failure when both providers fail", async () => {
    mockSearchProviders({});

    const result = await runSearch({ query: "no providers" });

    expect(result.success).toBe(false);
    expect(result.text).toContain("search returned no usable results");
  });

  it("requires a query", async () => {
    const result = await runSearch({});

    expect(result.success).toBe(false);
    expect(result.text).toContain("query is required");
  });

  it.each([
    ["ELIZA_WEB_SEARCH", "0"],
    ["ELIZA_INLINE_WEB_SEARCH", "off"],
  ])("denies %s without provider dispatch", async (key, value) => {
    vi.stubEnv(key, value);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      await webSearchAction.validate(
        {} as IAgentRuntime,
        {} as Memory,
        {} as State,
      ),
    ).toBe(false);
    const result = await runSearch({ query: "blocked" });
    expect(result.success).toBe(false);
    expect(result.text).toContain("disabled");
    expect(fetch).not.toHaveBeenCalled();
  });
});
