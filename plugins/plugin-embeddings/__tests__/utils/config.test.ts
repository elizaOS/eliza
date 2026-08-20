import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { getEmbeddingDimensions } from "../../src/utils/config";

function runtimeWithDimensions(value: string): IAgentRuntime {
  return {
    getSetting: (key: string) => (key === "EMBEDDING_DIMENSIONS" ? value : null),
  } as unknown as IAgentRuntime;
}

describe("getEmbeddingDimensions", () => {
  it("accepts a complete integer string", () => {
    expect(getEmbeddingDimensions(runtimeWithDimensions("1536"))).toBe(1536);
  });

  it.each(["1536oops", "1536.5", "0x600"])("rejects malformed integer setting %s", (value) => {
    expect(() => getEmbeddingDimensions(runtimeWithDimensions(value))).toThrow(
      "must be a valid integer"
    );
  });
});
