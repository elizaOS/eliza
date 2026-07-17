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

  it("drops an internal-only action callback memory restored as fallback text", () => {
    expect(
      shouldKeepConversationMessage(
        msg({
          text: "available_views:\ncalendar\nnotes",
          actionName: "VIEWS",
          actionCallbackHistory: ["available_views:", "calendar", "notes"],
        }),
      ),
    ).toBe(false);
  });

  it("drops a persisted VIEWS inventory envelope that lacks action metadata", () => {
    expect(
      shouldKeepConversationMessage(
        msg({
          text: [
            "available_views:",
            "  type: gui",
            "  count: 2",
            "views[2]{id,label,type,path,available}:",
            "  chat,Messages,gui,/chat,yes",
            "  notes,Notes,gui,/notes,yes",
          ].join("\n"),
        }),
      ),
    ).toBe(false);
  });

  it("keeps a real reply even when it also carries action callbacks", () => {
    expect(
      shouldKeepConversationMessage(
        msg({
          text: "Opening Notes now.",
          actionName: "VIEWS",
          actionCallbackHistory: ["available_views: calendar, notes"],
        }),
      ),
    ).toBe(true);
  });

  it("keeps callback-only text when the turn has user-visible media", () => {
    expect(
      shouldKeepConversationMessage(
        msg({
          text: "generated image",
          actionCallbackHistory: ["generated image"],
          attachments: [
            { id: "a", url: "/api/media/x.png", contentType: "image" },
          ],
        }),
      ),
    ).toBe(true);
  });
});
