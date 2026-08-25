import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { assertCompleteAnthropicGeneration, getAnthropicModelOutputLimit } from "./model-output";

describe("getAnthropicModelOutputLimit", () => {
  it("returns 128k for the documented large-context model names", () => {
    for (const name of [
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
    ]) {
      expect(getAnthropicModelOutputLimit(name), name).toBe(128_000);
    }
  });

  it("matches model names case-insensitively", () => {
    expect(getAnthropicModelOutputLimit("CLAUDE-OPUS-4-7")).toBe(128_000);
    expect(getAnthropicModelOutputLimit("Claude-Sonnet-4-6")).toBe(128_000);
  });

  it("returns 32k for unlisted opus-4 variants", () => {
    expect(getAnthropicModelOutputLimit("claude-opus-4-9")).toBe(32_000);
  });

  it("returns 64k for unknown or unlisted models", () => {
    expect(getAnthropicModelOutputLimit("claude-sonnet-4-5")).toBe(64_000);
    expect(getAnthropicModelOutputLimit("gpt-4o")).toBe(64_000);
    expect(getAnthropicModelOutputLimit("")).toBe(64_000);
  });
});

describe("assertCompleteAnthropicGeneration", () => {
  it("accepts an absent finish reason", () => {
    expect(() => assertCompleteAnthropicGeneration(undefined)).not.toThrow();
  });

  it("accepts non-budget finish reasons", () => {
    for (const reason of ["stop", "end_turn", "tool_use", "paused"]) {
      expect(() => assertCompleteAnthropicGeneration(reason), reason).not.toThrow();
    }
  });

  it("rejects a length-budget finish reason", () => {
    expect(() => assertCompleteAnthropicGeneration("length")).toThrow(ElizaError);
  });

  it("rejects every budget-exhausted finish-reason variant", () => {
    for (const reason of [
      "max_tokens",
      "max_output_tokens",
      "max_completion_tokens",
      "stop_length",
    ]) {
      expect(() => assertCompleteAnthropicGeneration(reason), reason).toThrow(
        /refusing to return partial model output/
      );
    }
  });

  it("normalizes hyphenated and cased budget variants before matching", () => {
    // Hyphen vs underscore and case/whitespace must not hide a budget stop.
    expect(() => assertCompleteAnthropicGeneration("max-tokens")).toThrow(/partial model output/);
    expect(() => assertCompleteAnthropicGeneration("  MAX_TOKENS  ")).toThrow(
      /partial model output/
    );
  });

  it("throws a coded MODEL_INCOMPLETE_OUTPUT error with provider context", () => {
    try {
      assertCompleteAnthropicGeneration("length");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe("MODEL_INCOMPLETE_OUTPUT");
      expect((error as ElizaError).context).toEqual({
        provider: "anthropic",
        finishReason: "length",
      });
    }
  });
});
