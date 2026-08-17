/** Verifies Ollama text support cannot claim the canonical semantic-embedding slot. */
import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { ollamaPlugin } from "../plugin";

describe("Ollama embedding registration", () => {
  it("preserves text generation while leaving TEXT_EMBEDDING to canonical providers", () => {
    expect(ollamaPlugin.models?.[ModelType.TEXT_SMALL]).toBeTypeOf("function");
    expect(ollamaPlugin.models?.[ModelType.TEXT_LARGE]).toBeTypeOf("function");
    expect(ollamaPlugin.models?.[ModelType.TEXT_EMBEDDING]).toBeUndefined();
  });
});
