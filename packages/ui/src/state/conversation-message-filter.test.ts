/**
 * Unit coverage for the transcript render filter (which assistant turns show).
 * Pure function, no harness.
 */
import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "../api";
import {
  ASSISTANT_DUPLICATE_WINDOW_MS,
  dedupeDoubledAssistantMessages,
  filterRenderableConversationMessages,
  shouldKeepConversationMessage,
} from "./conversation-message-filter";

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

describe("dedupeDoubledAssistantMessages", () => {
  const T = 1_700_000_000_000;

  it("collapses adjacent identical assistant turns inside the window (double-persist class)", () => {
    const result = dedupeDoubledAssistantMessages([
      msg({ id: "u1", role: "user", text: "hi", timestamp: T }),
      msg({ id: "a1", text: "hello there", timestamp: T + 100 }),
      msg({ id: "a2", text: "hello there", timestamp: T + 600 }),
    ]);
    expect(result.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("keeps identical assistant turns outside the window (intentional repeat)", () => {
    const input = [
      msg({ id: "a1", text: "sure", timestamp: T }),
      msg({
        id: "a2",
        text: "sure",
        timestamp: T + ASSISTANT_DUPLICATE_WINDOW_MS + 1,
      }),
    ];
    expect(dedupeDoubledAssistantMessages(input)).toBe(input);
  });

  it("keeps identical assistant turns separated by another turn (adjacency required)", () => {
    const input = [
      msg({ id: "a1", text: "yes", timestamp: T }),
      msg({ id: "u1", role: "user", text: "really?", timestamp: T + 200 }),
      msg({ id: "a2", text: "yes", timestamp: T + 400 }),
    ];
    expect(dedupeDoubledAssistantMessages(input)).toBe(input);
  });

  it("never collapses turns carrying attachments or blocks", () => {
    const withMedia = [
      msg({
        id: "a1",
        text: "here",
        timestamp: T,
        attachments: [{ id: "x", url: "/m.png", contentType: "image" }],
      }),
      msg({
        id: "a2",
        text: "here",
        timestamp: T + 100,
        attachments: [{ id: "y", url: "/n.png", contentType: "image" }],
      }),
    ];
    expect(dedupeDoubledAssistantMessages(withMedia)).toBe(withMedia);
  });

  it("never collapses duplicate USER turns (user may send the same text twice)", () => {
    const input = [
      msg({ id: "u1", role: "user", text: "ok", timestamp: T }),
      msg({ id: "u2", role: "user", text: "ok", timestamp: T + 100 }),
    ];
    expect(dedupeDoubledAssistantMessages(input)).toBe(input);
  });

  it("returns the SAME array reference when nothing collapses (render-path referential equality)", () => {
    const input = [
      msg({ id: "a1", text: "one", timestamp: T }),
      msg({ id: "a2", text: "two", timestamp: T + 100 }),
    ];
    expect(dedupeDoubledAssistantMessages(input)).toBe(input);
  });

  it("matches on trimmed text (whitespace-only differences are the same reply)", () => {
    const result = dedupeDoubledAssistantMessages([
      msg({ id: "a1", text: "hello", timestamp: T }),
      msg({ id: "a2", text: " hello \n", timestamp: T + 300 }),
    ]);
    expect(result.map((m) => m.id)).toEqual(["a1"]);
  });
});

describe("filterRenderableConversationMessages", () => {
  const T = 1_700_000_000_000;

  it("applies both the render filter and the duplicate collapse", () => {
    const result = filterRenderableConversationMessages([
      msg({ id: "u1", role: "user", text: "hi", timestamp: T }),
      msg({ id: "empty", text: "  ", timestamp: T + 10 }),
      msg({ id: "a1", text: "hey", timestamp: T + 20 }),
      msg({ id: "a2", text: "hey", timestamp: T + 400 }),
    ]);
    expect(result.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("collapses a double-persist even when an empty placeholder sits between the copies", () => {
    // The empty turn is filtered first, which makes the two copies adjacent —
    // exactly the shape a swallowed-then-retried stream leaves behind.
    const result = filterRenderableConversationMessages([
      msg({ id: "a1", text: "done", timestamp: T }),
      msg({ id: "ph", text: "", timestamp: T + 50 }),
      msg({ id: "a2", text: "done", timestamp: T + 900 }),
    ]);
    expect(result.map((m) => m.id)).toEqual(["a1"]);
  });
});
