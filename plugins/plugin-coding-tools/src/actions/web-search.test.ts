import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { webSearchAction } from "./web-search.js";

function makeRuntime(settings: Record<string, unknown> = {}): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

const message = {} as Memory;
const state: State | undefined = undefined;

describe("CODE_WEB_SEARCH delegated request", () => {
  it("returns success with delegatedRequest:true and echoes the query", async () => {
    const runtime = makeRuntime();
    const result = await webSearchAction.handler!(runtime, message, state, {
      parameters: { query: "elizaos plugin docs" },
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("not configured");
    expect(result.text).toContain('"elizaos plugin docs"');
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.delegatedRequest).toBe(true);
    expect(data?.query).toBe("elizaos plugin docs");
    expect(data?.allowed_domains).toBeUndefined();
    expect(data?.blocked_domains).toBeUndefined();
  });

  it("echoes allowed/blocked domain filters in data", async () => {
    const runtime = makeRuntime();
    const result = await webSearchAction.handler!(runtime, message, state, {
      parameters: {
        query: "test",
        allowed_domains: ["example.com", "docs.example.com"],
        blocked_domains: ["spam.example"],
      },
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.delegatedRequest).toBe(true);
    expect(data?.allowed_domains).toEqual(["example.com", "docs.example.com"]);
    expect(data?.blocked_domains).toEqual(["spam.example"]);
  });

  it("fails on missing query", async () => {
    const runtime = makeRuntime();
    const result = await webSearchAction.handler!(runtime, message, state, {
      parameters: {},
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });

  it("fails on empty/whitespace query", async () => {
    const runtime = makeRuntime();
    const result = await webSearchAction.handler!(runtime, message, state, {
      parameters: { query: "   " },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });
});
