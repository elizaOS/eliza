import { describe, expect, it } from "vitest";
import { rewriteOllamaChatBody } from "./ollama-chat-compat-fetch.ts";

describe("rewriteOllamaChatBody", () => {
  it("moves sampling fields into options", () => {
    const rewritten = rewriteOllamaChatBody({
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      top_p: 0.9,
      max_output_tokens: 128,
    });
    expect(rewritten.options).toEqual({
      temperature: 0.7,
      top_p: 0.9,
      num_predict: 128,
    });
    expect(rewritten.temperature).toBeUndefined();
    expect(rewritten.top_p).toBeUndefined();
    expect(rewritten.max_output_tokens).toBeUndefined();
  });

  it("drops tool_choice", () => {
    const rewritten = rewriteOllamaChatBody({
      model: "llama3",
      messages: [],
      tool_choice: "auto",
    });
    expect(rewritten.tool_choice).toBeUndefined();
  });

  it("keeps native options untouched", () => {
    const rewritten = rewriteOllamaChatBody({
      model: "llama3",
      messages: [],
      options: { temperature: 0.3, num_predict: 64 },
    });
    expect(rewritten.options).toEqual({ temperature: 0.3, num_predict: 64 });
  });

  it("returns the same object when nothing needs rewriting", () => {
    const body = { model: "llama3", messages: [] };
    const rewritten = rewriteOllamaChatBody(body);
    expect(rewritten).toBe(body);
  });
});
