import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { assertCompleteOllamaGeneration, assertZerollamaStreamTerminated } from "../model-output";

describe("assertCompleteOllamaGeneration", () => {
  it("accepts an absent finish reason", () => {
    expect(() => assertCompleteOllamaGeneration(undefined, "ollama")).not.toThrow();
  });

  it("accepts normal completion reasons", () => {
    for (const reason of ["stop", "tool_calls", "function_call", "eos_token"]) {
      expect(() => assertCompleteOllamaGeneration(reason, "ollama"), reason).not.toThrow();
    }
  });

  it("rejects budget-exhausted finish reasons for ollama", () => {
    for (const reason of [
      "length",
      "max_tokens",
      "max_output_tokens",
      "max_completion_tokens",
      "stop_length",
    ]) {
      expect(() => assertCompleteOllamaGeneration(reason, "ollama"), reason).toThrowError(
        ElizaError
      );
    }
  });

  it("normalizes case, whitespace, and hyphen separators before matching", () => {
    for (const reason of [" MAX_TOKENS ", "max-tokens", "Max_Output_Tokens", "STOP-LENGTH"]) {
      expect(() => assertCompleteOllamaGeneration(reason, "zerollama"), reason).toThrowError(
        ElizaError
      );
    }
  });

  it("carries the provider and original finish reason in error context", () => {
    try {
      assertCompleteOllamaGeneration("max_tokens", "ollama");
      expect.unreachable("expected throw");
    } catch (error) {
      const err = error as ElizaError;
      expect(err.code).toBe("MODEL_INCOMPLETE_OUTPUT");
      expect(err.context).toEqual({ provider: "ollama", finishReason: "max_tokens" });
    }
  });
});

describe("assertZerollamaStreamTerminated", () => {
  it("accepts a terminal event that means the output is complete", () => {
    expect(() => assertZerollamaStreamTerminated("stop")).not.toThrow();
  });

  it("rejects a terminal event that means the output is a prefix", () => {
    for (const reason of ["length", "max_tokens", "stop_length"]) {
      expect(() => assertZerollamaStreamTerminated(reason), reason).toThrowError(
        /zerollama reached its output boundary/
      );
    }
  });

  it("fails closed when the stream ended without any terminal event", () => {
    expect(() => assertZerollamaStreamTerminated(undefined)).toThrowError(ElizaError);
    try {
      assertZerollamaStreamTerminated(undefined);
      expect.unreachable("expected throw");
    } catch (error) {
      const err = error as ElizaError;
      expect(err.code).toBe("MODEL_INCOMPLETE_OUTPUT");
      expect(err.context).toEqual({ provider: "zerollama", finishReason: null });
      expect(err.message).toMatch(/without a terminal event/);
    }
  });
});
