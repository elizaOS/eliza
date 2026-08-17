/** Verifies Gemini text/image support cannot claim the canonical semantic-embedding slot. */
import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { googleGenAIPlugin } from "../index";

describe("Google GenAI embedding registration", () => {
  it("preserves text generation while leaving TEXT_EMBEDDING to canonical providers", () => {
    expect(googleGenAIPlugin.models?.[ModelType.TEXT_SMALL]).toBeTypeOf(
      "function",
    );
    expect(googleGenAIPlugin.models?.[ModelType.TEXT_LARGE]).toBeTypeOf(
      "function",
    );
    expect(
      googleGenAIPlugin.models?.[ModelType.TEXT_EMBEDDING],
    ).toBeUndefined();
  });
});
