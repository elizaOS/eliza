import type { ContextObject } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { renderMessageHandlerModelInput } from "./stage1-input.ts";

describe("stage1 reply reference placement (issue #37025)", () => {
  it("renders reply_reference directly before # Current message and after # Conversation", () => {
    const context: ContextObject = {
      id: "turn",
      metadata: { roomId: "room", messageId: "turn" },
      events: [
        {
          id: "instruction:system",
          type: "instruction",
          content: "You are a helpful assistant.",
        },
        {
          id: "other-turn-segment:1",
          type: "segment",
          source: "platform",
          segment: {
            id: "other-turn-segment:1",
            label: "custom_context",
            content: "custom extra context",
            stable: false,
          },
        },
        {
          id: "reply-reference:parent-1",
          type: "segment",
          source: "discord",
          segment: {
            id: "reply-reference:parent-1",
            label: "reply_reference",
            content: "Alice: What did you mean by this earlier?\n(platform message id: 12345)",
            stable: false,
          },
        },
        {
          id: "message:current",
          type: "segment",
          source: "discord",
          segment: {
            id: "message:current",
            label: "message:user",
            content: "what did you mean by this",
            stable: false,
          },
        },
      ],
    };

    const rendered = renderMessageHandlerModelInput(
      { character: { name: "Eliza" } },
      context,
      [],
      { directMessage: true },
    );

    const userMessage = rendered.messages.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    const content = userMessage?.content ?? "";

    const otherPos = content.indexOf("custom_context:\ncustom extra context");
    const taskPos = content.indexOf("# Task");
    const convPos = content.indexOf("# Conversation");
    const replyRefPos = content.indexOf("reply_reference:\nAlice: What did you mean by this earlier?\n(platform message id: 12345)");
    const currentMsgPos = content.indexOf("# Current message\nwhat did you mean by this");

    // otherTurnSegments must be before # Task
    expect(otherPos).toBeGreaterThanOrEqual(0);
    expect(taskPos).toBeGreaterThan(otherPos);

    // # Task and # Conversation must precede reply_reference
    expect(convPos).toBeGreaterThan(taskPos);
    expect(replyRefPos).toBeGreaterThan(convPos);

    // reply_reference must precede # Current message
    expect(currentMsgPos).toBeGreaterThan(replyRefPos);

    // Verify ordering in promptSegments array
    const replySegIdx = rendered.promptSegments.findIndex(
      (s) => s.label === "reply_reference",
    );
    const currentMsgSegIdx = rendered.promptSegments.findIndex(
      (s) => s.label === "message:user",
    );
    expect(replySegIdx).toBeGreaterThanOrEqual(0);
    expect(currentMsgSegIdx).toBe(replySegIdx + 1);
  });

  it("renders correctly when no reply_reference is present", () => {
    const context: ContextObject = {
      id: "turn",
      metadata: { roomId: "room", messageId: "turn" },
      events: [
        {
          id: "message:current",
          type: "segment",
          source: "discord",
          segment: {
            id: "message:current",
            label: "message:user",
            content: "hello world",
            stable: false,
          },
        },
      ],
    };

    const rendered = renderMessageHandlerModelInput(
      { character: { name: "Eliza" } },
      context,
      [],
      { directMessage: true },
    );

    const userMessage = rendered.messages.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    const content = userMessage?.content ?? "";

    expect(content).toContain("# Task");
    expect(content).toContain("# Conversation");
    expect(content).toContain("# Current message\nhello world");
    expect(content).not.toContain("reply_reference:");
  });
});
