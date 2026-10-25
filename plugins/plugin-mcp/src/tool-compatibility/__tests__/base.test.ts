/** Verifies that shared model detection preserves the local MCP facade contract. */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { detectModelProvider } from "../base";

function runtime(modelProvider: string, model: string): IAgentRuntime {
  return { modelProvider, model } as unknown as IAgentRuntime;
}

describe("detectModelProvider", () => {
  it("preserves the OpenRouter fallback for unknown and BitRouter models", () => {
    expect(detectModelProvider(runtime("custom", "custom-model")).provider).toBe("openrouter");
    expect(detectModelProvider(runtime("bitrouter", "bitrouter/model")).provider).toBe(
      "openrouter"
    );
  });

  it("retains recognized provider capability metadata", () => {
    expect(detectModelProvider(runtime("openai", "gpt-5.5")).provider).toBe("openai");
    expect(detectModelProvider(runtime("anthropic", "claude-sonnet")).provider).toBe("anthropic");
  });
});
