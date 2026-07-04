/**
 * Unit coverage for the transcript render filter (which assistant turns show).
 * Pure function, no harness.
 */
import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "../api";
import { shouldKeepConversationMessage } from "./conversation-message-filter";

function msg(partial: Partial<ConversationMessage>): ConversationMessage {
  return {
    id: "m1",
    role: "assistant",
    text: "",
    timestamp: 0,
    ...partial,
  };
}

describe("shouldKeepConversationMessage", () => {
  it("always keeps user turns", () => {
    expect(shouldKeepConversationMessage(msg({ role: "user", text: "" }))).toBe(
      true,
    );
  });

  it("keeps assistant turns with text", () => {
    expect(shouldKeepConversationMessage(msg({ text: "hi" }))).toBe(true);
  });

  it("drops empty assistant turns with no media or blocks", () => {
    expect(shouldKeepConversationMessage(msg({ text: "  " }))).toBe(false);
  });

  it("keeps an image-only assistant turn (empty text, has attachments)", () => {
    expect(
      shouldKeepConversationMessage(
        msg({
          text: "",
          attachments: [
            { id: "a", url: "/api/media/x.png", contentType: "image" },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("keeps an empty assistant turn that carries A2UI blocks", () => {
    expect(
      shouldKeepConversationMessage(
        msg({ text: "", blocks: [{ type: "text", text: "x" }] }),
      ),
    ).toBe(true);
  });
});
