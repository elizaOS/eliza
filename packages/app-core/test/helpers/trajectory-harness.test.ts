import { describe, expect, it } from "vitest";
import { serializeLlmCallResult } from "./trajectory-harness.ts";

describe("trajectory harness", () => {
  it("serializes model errors as first-class trajectory errors", () => {
    const result = serializeLlmCallResult({
      error:
        "[Anthropic] TEXT_SMALL request using claude failed: credit balance is too low",
    });

    expect(result.error).toContain("credit balance is too low");
    expect(result.response).toContain("TEXT_SMALL request");
  });

  it("keeps successful text responses as output text", () => {
    const result = serializeLlmCallResult("hello");

    expect(result).toEqual({ response: "hello" });
  });
});
