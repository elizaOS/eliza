import { describe, expect, it } from "vitest";
import {
  buildResponsesInput,
  extractPlaygroundErrorMessage,
  extractPlaygroundResponseText,
  extractPlaygroundUsage,
} from "./model-playground-utils";

describe("model playground utils", () => {
  it("extracts assistant text and usage from a chat completions payload", () => {
    const payload = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Chat completion response",
          },
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 45,
        total_tokens: 165,
      },
    };

    expect(extractPlaygroundResponseText(payload)).toBe("Chat completion response");
    expect(extractPlaygroundUsage(payload)).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
    });
  });

  it("extracts assistant text and usage from a responses payload", () => {
    const payload = {
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "First line" },
            { type: "output_text", text: "Second line" },
          ],
        },
      ],
      usage: {
        input_tokens: 80,
        output_tokens: 32,
        total_tokens: 112,
      },
    };

    expect(extractPlaygroundResponseText(payload)).toBe("First line\nSecond line");
    expect(extractPlaygroundUsage(payload)).toEqual({
      inputTokens: 80,
      outputTokens: 32,
      totalTokens: 112,
    });
  });

  it("builds responses input turns without changing role or content", () => {
    expect(
      buildResponsesInput([
        { role: "user", content: "Compare these models." },
        { role: "assistant", content: "Here is the baseline." },
      ]),
    ).toEqual([
      { role: "user", content: "Compare these models." },
      { role: "assistant", content: "Here is the baseline." },
    ]);
  });

  it("prefers structured error messages and falls back to status-based defaults", () => {
    expect(
      extractPlaygroundErrorMessage({
        error: {
          message: "API key is required for this endpoint",
        },
      }),
    ).toBe("API key is required for this endpoint");

    expect(extractPlaygroundErrorMessage(null, 402)).toBe(
      "This request could not run because the account does not have enough credits.",
    );
    expect(extractPlaygroundErrorMessage(null, 500)).toBe(
      "The model request failed on the server. Please try again.",
    );
  });
});
