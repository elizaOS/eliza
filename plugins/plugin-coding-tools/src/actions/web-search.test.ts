/**
 * WEB_SEARCH coverage for the coding-tools plugin: Parallel primary, Exa
 * fallback, MCP JSON/SSE parsing, bounded output, and stable result metadata.
 * Provider calls are routed through the guarded HTTP test seam.
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
  __setWebHttpLookupFnForTests,
  __setWebHttpPinnedFetchImplForTests,
} from "../lib/web-http.js";
import { webSearchAction } from "./web-search.js";

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
  __setWebHttpLookupFnForTests(async () => [{ address: PUBLIC_IP, family: 4 }]);
  __setWebHttpPinnedFetchImplForTests(async ({ url }) => {
    const host = url.hostname;
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
  afterEach(() => {
    __resetWebHttpTestOverrides();
  });

  it("returns bounded Parallel results with stable metadata", async () => {
    mockSearchProviders({
      parallel: mcpJson("Parallel result\nhttps://example.com"),
    });

    const result = await runSearch({ query: "elizaOS latest" });

    expect(result.success).toBe(true);
    expect(result.text).toContain("Parallel result");
    expect(result.data).toMatchObject({
      action: "WEB_SEARCH",
      provider: "parallel",
      truncated: false,
    });
  });

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

  it("caps result output before returning it to the model", async () => {
    mockSearchProviders({ parallel: mcpJson("y".repeat(20_000)) });

    const result = await runSearch({ query: "large result" });

    expect(result.success).toBe(true);
    expect((result.text ?? "").length).toBeLessThanOrEqual(4_012);
    expect(result.data).toMatchObject({
      provider: "parallel",
      truncated: true,
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

  it("honors the ELIZA_WEB_SEARCH master kill switch", async () => {
    const previous = process.env.ELIZA_WEB_SEARCH;
    process.env.ELIZA_WEB_SEARCH = "0";
    try {
      __setWebHttpPinnedFetchImplForTests(async () => {
        throw new Error("search providers should not be called");
      });

      const valid = await webSearchAction.validate(
        {} as IAgentRuntime,
        {} as Memory,
        {} as State,
      );
      expect(valid).toBe(false);

      const result = await runSearch({ query: "blocked" });
      expect(result.success).toBe(false);
      expect(result.text).toContain("disabled");
    } finally {
      if (previous === undefined) delete process.env.ELIZA_WEB_SEARCH;
      else process.env.ELIZA_WEB_SEARCH = previous;
    }
  });

  it("honors ELIZA_INLINE_WEB_SEARCH=0 for the inline keyless surface", async () => {
    const previous = process.env.ELIZA_INLINE_WEB_SEARCH;
    process.env.ELIZA_INLINE_WEB_SEARCH = "off";
    try {
      const result = await runSearch({ query: "blocked inline" });
      expect(result.success).toBe(false);
      expect(result.text).toContain("disabled");
    } finally {
      if (previous === undefined) delete process.env.ELIZA_INLINE_WEB_SEARCH;
      else process.env.ELIZA_INLINE_WEB_SEARCH = previous;
    }
  });
});
