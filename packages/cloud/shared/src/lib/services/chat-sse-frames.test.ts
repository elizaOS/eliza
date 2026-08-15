/**
 * Contract tests for the canonical chat SSE frame builder shared by every
 * Cloud chat producer (#17122): each frame keeps its named `event:` line,
 * stamps the canonical JSON `type`, and the canonical type cannot be
 * overridden by a payload field.
 */
import { describe, expect, test } from "bun:test";
import { chatSseFrame, normalizeChatSseDonePayload } from "./chat-sse-frames";

describe("chatSseFrame", () => {
  test("stamps the canonical JSON type for each named event", () => {
    expect(chatSseFrame("chunk", { text: "hi" })).toBe(
      'event: chunk\ndata: {"text":"hi","type":"token"}\n\n',
    );
    expect(chatSseFrame("done", { fullText: "hi" })).toBe(
      'event: done\ndata: {"fullText":"hi","type":"done"}\n\n',
    );
    expect(chatSseFrame("error", { message: "boom" })).toBe(
      'event: error\ndata: {"message":"boom","type":"error"}\n\n',
    );
  });

  test("the canonical type wins over a conflicting payload field", () => {
    const frame = chatSseFrame("done", { type: "token", fullText: "hi" });
    const data = JSON.parse(frame.split("\ndata: ")[1] ?? "{}") as {
      type?: string;
    };
    expect(data.type).toBe("done");
  });
});

describe("normalizeChatSseDonePayload", () => {
  test("preserves the terminal client contract and authoritative upstream IDs", () => {
    expect(
      normalizeChatSseDonePayload(
        {
          messageId: "upstream-assistant",
          userMessageId: "upstream-user",
          text: "final answer",
          actionResults: [{ actionName: "VIEWS", success: true }],
          usage: { totalTokens: 4 },
          failureKind: "no_provider",
          accountConnect: { provider: "openai" },
          untrustedExtra: "drop-me",
        },
        { messageId: "fallback", fullText: "partial" },
      ),
    ).toEqual({
      userMessageId: "upstream-user",
      failureKind: "no_provider",
      accountConnect: { provider: "openai" },
      actionResults: [{ actionName: "VIEWS", success: true }],
      usage: { totalTokens: 4 },
      messageId: "upstream-assistant",
      text: "final answer",
      fullText: "final answer",
    });
  });

  test("uses generated identity and accumulated text only when upstream omits them", () => {
    expect(
      normalizeChatSseDonePayload({}, { messageId: "generated", fullText: "accumulated" }),
    ).toEqual({
      messageId: "generated",
      text: "accumulated",
      fullText: "accumulated",
    });
  });
});
