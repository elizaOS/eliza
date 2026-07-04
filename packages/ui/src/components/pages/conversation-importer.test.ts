import { describe, expect, it } from "vitest";
import {
  formatImportedConversationMemory,
  parseConversationImport,
  redactConversationImportText,
} from "./conversation-importer";

describe("conversation importer", () => {
  it("parses ChatGPT mapping exports and redacts secrets by default", () => {
    const preview = parseConversationImport(
      "chatgpt",
      JSON.stringify({
        conversations: [
          {
            title: "Build notes",
            mapping: {
              a: {
                message: {
                  author: { role: "user" },
                  create_time: 1_700_000_000,
                  content: {
                    parts: ["my api_key = sk-1234567890abcdef"],
                  },
                },
              },
              b: {
                message: {
                  author: { role: "assistant" },
                  content: { parts: ["Saved that note."] },
                },
              },
            },
          },
        ],
      }),
    );

    expect(preview.counts).toMatchObject({
      conversations: 1,
      turns: 2,
      redactions: 1,
    });
    expect(preview.examples[0]?.conversationTitle).toBe("Build notes");
    expect(preview.examples[0]?.text).toContain("[REDACTED]");
  });

  it("parses Claude-style chat_messages exports", () => {
    const preview = parseConversationImport(
      "claude",
      JSON.stringify([
        {
          name: "Planning",
          chat_messages: [
            { sender: "human", text: "hello" },
            { sender: "assistant", text: "hi" },
          ],
        },
      ]),
    );

    expect(preview.counts.turns).toBe(2);
    expect(preview.examples.map((turn) => turn.speaker)).toEqual([
      "human",
      "assistant",
    ]);
  });

  it("falls back to plain-text paragraph turns for invalid JSON", () => {
    const preview = parseConversationImport(
      "hermes",
      "first paragraph\n\nsecond paragraph",
    );

    expect(preview.counts.turns).toBe(2);
    expect(preview.warnings[0]).toContain("plain text");
  });

  it("formats imported memories with a batch marker for later review/delete", () => {
    const memoryText = formatImportedConversationMemory(
      "openclaw",
      {
        conversationTitle: "Session",
        speaker: "assistant",
        text: "answer",
        createdAt: Date.UTC(2026, 0, 1),
      },
      "batch-1",
    );

    expect(memoryText).toContain("[conversation-import:batch-1]");
    expect(memoryText).toContain("Source: openclaw");
    expect(memoryText).toContain("answer");
  });

  it("redacts email and password-looking values", () => {
    const result = redactConversationImportText(
      "email me@example.com password=supersecret",
    );

    expect(result.redactions).toBe(2);
    expect(result.text).not.toContain("me@example.com");
    expect(result.text).not.toContain("supersecret");
  });
});
