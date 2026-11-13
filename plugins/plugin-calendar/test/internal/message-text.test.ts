import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { messageText } from "../../src/internal/detail.js";

describe("calendar messageText", () => {
  it("reads the request inside chat augmentation's help-document envelope", () => {
    // content.text as packages/agent/src/api/chat-augmentation.ts rewrites it
    // ("friday one" matched help fragments through the word "one"; live
    // :5325 2026-10-30, tj-ff1cb328f785fb).
    const text = [
      "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
      "If the answer appears verbatim in the contextual documents, repeat it exactly.",
      "Do not ask follow-up questions or invoke tools/actions when the contextual documents already answer the request.",
      "",
      "<contextual_documents>",
      '<source title="source-1" similarity="1.000">',
      'Q: How do I see the tutorial again?\nA: Type "restart tutorial" in the chat any time. The tour runs right in the conversation and is always re-runnable — nothing is one-time-only.',
      "</source>",
      "</contextual_documents>",
      "",
      "<user_request>",
      "friday one",
      "</user_request>",
    ].join("\n");
    expect(messageText({ content: { text } } as Memory)).toBe("friday one");
  });
});
