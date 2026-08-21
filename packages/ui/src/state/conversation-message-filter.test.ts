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

  it("keeps a zero-token interrupted receipt despite empty text", () => {
    expect(
      shouldKeepConversationMessage(msg({ text: "", interrupted: true })),
    ).toBe(true);
  });

  it("still drops empty assistant turns that are not interrupted", () => {
    expect(shouldKeepConversationMessage(msg({ text: "  " }))).toBe(false);
  });

  it("drops explicitly internal assistant turns before considering media", () => {
    expect(
      shouldKeepConversationMessage(
        msg({
          text: "available_views:\nviews[1]{id}: notes",
          transcriptVisibility: "internal",
          attachments: [
            { id: "a", url: "/api/media/x.png", contentType: "image" },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("drops a preserved legacy inventory only when callback history matches", () => {
    const inventory =
      "available_views:\nviews[1]{id,label}: notes,Notes\nsubviews[0]:";
    expect(
      shouldKeepConversationMessage(
        msg({
          text: inventory,
          actionCallbackHistory: [
            "available_views:",
            "views[1]{id,label}: notes,Notes",
            "subviews[0]:",
          ],
        }),
      ),
    ).toBe(false);
    expect(
      shouldKeepConversationMessage(
        msg({
          text: inventory,
          actionCallbackHistory: ["I found Notes."],
        }),
      ),
    ).toBe(true);
  });

  it("drops the complete legacy TOON envelope without callback history", () => {
    expect(
      shouldKeepConversationMessage(
        msg({
          text: [
            "available_views:",
            "views[1]{id,label,type,path,available}:",
            "  notes,Notes,gui,/notes,true",
          ].join("\n"),
        }),
      ),
    ).toBe(false);
  });

  it("drops an empty legacy inventory without a views table", () => {
    expect(
      shouldKeepConversationMessage(
        msg({
          text: ["available_views:", "  type: gui", "  count: 0"].join("\n"),
        }),
      ),
    ).toBe(false);
  });

  it("keeps ordinary prose that mentions available views", () => {
    expect(
      shouldKeepConversationMessage(
        msg({
          text: "available_views: Notes and Calendar are ready to use.",
        }),
      ),
    ).toBe(true);
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
