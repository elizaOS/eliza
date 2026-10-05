import { describe, expect, it } from "vitest";
import { parseProactiveMessageEvent } from "./parsers";

describe("proactive message failure classification", () => {
  it.each(["no_provider", "provider_issue", "insufficient_credits"])(
    "retains validated assistant failure %s",
    (failureKind) => {
      expect(
        parseProactiveMessageEvent({
          conversationId: "conversation",
          message: {
            id: "notice",
            role: "assistant",
            text: "Setup required",
            timestamp: 1,
            failureKind,
          },
        })?.message.failureKind,
      ).toBe(failureKind);
    },
  );
  it.each(["made_up", 42, { kind: "no_provider" }])(
    "rejects unrecognized failure metadata %j",
    (failureKind) => {
      expect(
        parseProactiveMessageEvent({
          conversationId: "conversation",
          message: {
            id: "notice",
            role: "assistant",
            text: "Alert",
            timestamp: 1,
            failureKind,
          },
        })?.message.failureKind,
      ).toBeUndefined();
    },
  );
  it("does not give a user message an assistant setup classification", () => {
    expect(
      parseProactiveMessageEvent({
        conversationId: "conversation",
        message: {
          id: "user",
          role: "user",
          text: "Hello",
          timestamp: 1,
          failureKind: "no_provider",
        },
      })?.message.failureKind,
    ).toBeUndefined();
  });
});
