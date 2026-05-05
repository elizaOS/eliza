import { describe, expect, test } from "bun:test";

import {
  ANTHROPIC_WEB_SEARCH_INPUT_TOKEN_BUFFER,
  buildProviderNativeWebSearchTools,
  DEFAULT_ANTHROPIC_WEB_SEARCH_MAX_USES,
  isAnthropicWebSearchEnabled,
  supportsAnthropicWebSearch,
} from "@/lib/providers/anthropic-web-search";

function requireWebSearchToolMetadata(tool: unknown): {
  type?: string;
  id?: string;
  args: { maxUses?: number };
} {
  expect(tool).toBeDefined();
  if (!tool || typeof tool !== "object") {
    throw new Error("Expected the Anthropic web_search tool to be registered");
  }

  const typedTool = tool as {
    type?: string;
    id?: string;
    args?: { maxUses?: number };
  };

  expect(typedTool.args).toBeDefined();
  if (!typedTool.args || typeof typedTool.args !== "object") {
    throw new Error("Expected the Anthropic web_search tool args to be registered");
  }

  return {
    type: typedTool.type,
    id: typedTool.id,
    args: typedTool.args,
  };
}

describe("anthropic web search helpers", () => {
  test("supports allowlisted Anthropic models and dated variants", () => {
    expect(supportsAnthropicWebSearch("claude-sonnet-4-6")).toBe(true);
    expect(supportsAnthropicWebSearch("anthropic/claude-opus-4-7-20260301")).toBe(true);
    expect(supportsAnthropicWebSearch("claude-haiku-4-5-20251001-5")).toBe(false);
  });

  test("only enables web search for supported Anthropic models when explicitly requested", () => {
    expect(isAnthropicWebSearchEnabled("anthropic", "claude-sonnet-4-6", true)).toBe(true);
    expect(isAnthropicWebSearchEnabled("anthropic", "claude-sonnet-4-6", false)).toBe(false);
    expect(isAnthropicWebSearchEnabled("openai", "gpt-5-mini", true)).toBe(false);
    expect(isAnthropicWebSearchEnabled("anthropic", "claude-haiku-4-5-20251001-5", true)).toBe(
      false,
    );
  });

  test("builds Anthropic provider-native tools with the default maxUses", () => {
    const tools = buildProviderNativeWebSearchTools({
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-6",
      enabled: true,
    });

    expect("tools" in tools).toBe(true);
    if (!("tools" in tools)) {
      throw new Error("Expected provider-native web search tools");
    }

    const webSearchTool = requireWebSearchToolMetadata(tools.tools.web_search);

    expect(webSearchTool.type).toBe("provider");
    expect(webSearchTool.id).toBe("anthropic.web_search_20260209");
    expect(webSearchTool.args.maxUses).toBe(DEFAULT_ANTHROPIC_WEB_SEARCH_MAX_USES);
  });

  test("clamps requested maxUses and skips unsupported requests", () => {
    const disabled = buildProviderNativeWebSearchTools({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      enabled: false,
      maxUses: 99,
    });
    expect(disabled).toEqual({});

    const tools = buildProviderNativeWebSearchTools({
      provider: "anthropic",
      model: "claude-opus-4-7",
      enabled: true,
      maxUses: 99,
    });

    expect("tools" in tools).toBe(true);
    if (!("tools" in tools)) {
      throw new Error("Expected provider-native web search tools");
    }

    const webSearchTool = requireWebSearchToolMetadata(tools.tools.web_search);

    expect(webSearchTool.args.maxUses).toBe(10);
  });

  test("exports the reservation buffer used for search-enabled requests", () => {
    expect(ANTHROPIC_WEB_SEARCH_INPUT_TOKEN_BUFFER).toBe(10_000);
  });
});
