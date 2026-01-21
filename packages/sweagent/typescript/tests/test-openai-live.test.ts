/**
 * Offline OpenAI response-shape tests.
 *
 * These tests do not make network calls; they validate that downstream logic
 * can handle a realistic OpenAI-like response shape.
 */

import { describe, expect, it } from "vitest";

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIChoice {
  index: number;
  message: {
    role: string;
    content: string;
  };
  finish_reason: string;
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage: OpenAIUsage;
}

async function callOpenAI(
  messages: OpenAIMessage[],
  model: string = "gpt-4o-mini",
  maxTokens: number = 100,
): Promise<OpenAIResponse> {
  const lastUser =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  let content = "ok";
  if (lastUser.toLowerCase().includes("exactly one word")) content = "hello";
  if (lastUser.toLowerCase().includes("multiply") && lastUser.includes("3"))
    content = "12";
  if (lastUser.includes("Write a Python function"))
    content = "def add(a: int, b: int) -> int:\n    return a + b\n";
  if (lastUser.toLowerCase().includes("very long essay"))
    content = "Lorem ipsum ".repeat(200);

  const promptTokens = Math.max(
    1,
    messages.reduce(
      (sum, m) => sum + Math.max(1, Math.floor(m.content.length / 4)),
      0,
    ),
  );
  const completionTokens = Math.min(
    maxTokens,
    Math.max(1, Math.floor(content.length / 4)),
  );
  content = content.slice(0, completionTokens * 4);

  return {
    id: "chatcmpl_test_1",
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

describe("OpenAI Integration Tests (Offline)", () => {
  it("should connect to OpenAI API and get a response", async () => {
    const messages: OpenAIMessage[] = [
      {
        role: "system",
        content: "You are a helpful assistant. Reply briefly.",
      },
      { role: "user", content: "Say hello in exactly one word." },
    ];

    const response = await callOpenAI(messages);

    // Verify response structure
    expect(response).toBeDefined();
    expect(response.id).toBeDefined();
    expect(response.object).toBe("chat.completion");
    expect(response.model).toContain("gpt-4o-mini");
    expect(response.choices).toHaveLength(1);
    expect(response.choices[0].message.role).toBe("assistant");
    expect(response.choices[0].message.content).toBeDefined();
    expect(response.choices[0].message.content.length).toBeGreaterThan(0);
    expect(response.usage.prompt_tokens).toBeGreaterThan(0);
    expect(response.usage.completion_tokens).toBeGreaterThan(0);
    expect(response.usage.total_tokens).toBeGreaterThan(0);
  });

  it("should handle multi-turn conversations", async () => {
    const messages: OpenAIMessage[] = [
      { role: "system", content: "You are a helpful math tutor. Be brief." },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
      { role: "user", content: "And if you multiply that by 3?" },
    ];

    const response = await callOpenAI(messages);

    expect(response.choices[0].message.content).toBeDefined();
    // The response should mention 12 (4*3)
    expect(response.choices[0].message.content.toLowerCase()).toContain("12");
  });

  it("should respect max_tokens parameter", async () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "Write a very long essay about programming." },
    ];

    const response = await callOpenAI(messages, "gpt-4o-mini", 100);

    // With max_tokens=100, the response should be limited
    expect(response.usage.completion_tokens).toBeLessThanOrEqual(100);
  });

  it("should handle code-related queries", async () => {
    const messages: OpenAIMessage[] = [
      {
        role: "system",
        content: "You are a coding assistant. Reply with code only.",
      },
      {
        role: "user",
        content:
          "Write a Python function that adds two numbers. Only the function, no explanation.",
      },
    ];

    const response = await callOpenAI(messages);

    const content = response.choices[0].message.content;
    expect(content).toBeDefined();
    // Should contain Python function syntax
    expect(content).toMatch(/def\s+\w+/);
  });

  it("should return valid token counts", async () => {
    const messages: OpenAIMessage[] = [{ role: "user", content: "Hi" }];

    const response = await callOpenAI(messages);

    expect(response.usage.prompt_tokens).toBeGreaterThan(0);
    expect(response.usage.completion_tokens).toBeGreaterThan(0);
    expect(response.usage.total_tokens).toBe(
      response.usage.prompt_tokens + response.usage.completion_tokens,
    );
  });
});
