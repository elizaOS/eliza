/**
 * Wire-shape tests for the xAI system-prompt plumbing: the request body sent
 * to /chat/completions must carry the resolved system instruction as a leading
 * system message (caller `params.system` first, character identity fallback),
 * without duplicating a system message the caller already provided.
 * Deterministic harness: fetch is mocked; no live API.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTextSmall } from "../models/grok";

function createRuntime(character?: Record<string, unknown>) {
  return {
    character: character ?? {
      name: "Grokky",
      system: "character system prompt",
    },
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        XAI_API_KEY: "test-key",
        XAI_SMALL_MODEL: "grok-test-small",
      };
      return settings[key] ?? null;
    }),
  } as IAgentRuntime;
}

function mockChatCompletion(text = "ok") {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "grok-test-small",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: text },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);
  return fetchMock;
}

function requestMessages(fetchMock: ReturnType<typeof vi.fn>) {
  const body = fetchMock.mock.calls[0]?.[1]?.body;
  return (
    JSON.parse(String(body)) as {
      messages: Array<{ role: string; content: string }>;
    }
  ).messages;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("xAI system prompt plumbing", () => {
  it("sends caller params.system as a leading system message", async () => {
    const fetchMock = mockChatCompletion();
    await handleTextSmall(createRuntime(), {
      prompt: "hi",
      system: "You are a precise test agent.",
    });

    const messages = requestMessages(fetchMock);
    expect(messages).toEqual([
      { role: "system", content: "You are a precise test agent." },
      { role: "user", content: "hi" },
    ]);
  });

  it("falls back to the character identity when params.system is absent", async () => {
    const fetchMock = mockChatCompletion();
    await handleTextSmall(createRuntime(), { prompt: "hi" });

    const messages = requestMessages(fetchMock);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("character system prompt");
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("does not duplicate a system message the caller already leads with", async () => {
    const fetchMock = mockChatCompletion();
    await handleTextSmall(createRuntime(), {
      messages: [
        { role: "system", content: "already here" },
        { role: "user", content: "hi" },
      ],
    } as never);

    const messages = requestMessages(fetchMock);
    expect(
      messages.filter((message) => message.role === "system"),
    ).toHaveLength(1);
    expect(messages[0]).toEqual({ role: "system", content: "already here" });
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
  });
});
