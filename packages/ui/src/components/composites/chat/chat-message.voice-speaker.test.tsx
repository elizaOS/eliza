// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatMessage } from "./chat-message";
import type { ChatMessageData } from "./chat-types";

afterEach(() => {
  cleanup();
});

function makeMessage(
  overrides: Partial<ChatMessageData> = {},
): ChatMessageData {
  return {
    id: "msg-1",
    role: "user",
    text: "hello",
    ...overrides,
  };
}

describe("ChatMessage voice speaker surfacing", () => {
  it("renders the voice speaker badge when voiceSpeaker has a different name from the sender", () => {
    // When `from` is set the sender header shows that label; the voice badge
    // surfaces the captured speaker so a multi-speaker room stays legible.
    render(
      <ChatMessage
        message={makeMessage({
          from: "Owner Device",
          voiceSpeaker: { name: "Alex", isOwner: false },
        })}
      />,
    );
    const badge = screen.getByTestId("chat-message-voice-speaker-msg-1");
    expect(badge.textContent).toContain("Alex");
    expect(badge.getAttribute("data-owner")).toBeNull();
  });

  it("renders the OWNER crown when the voiceSpeaker is the owner", () => {
    render(
      <ChatMessage
        message={makeMessage({
          from: "Owner Device",
          voiceSpeaker: { name: "Shaw", isOwner: true },
        })}
      />,
    );
    expect(
      screen
        .getByTestId("chat-message-voice-speaker-msg-1")
        .getAttribute("data-owner"),
    ).toBe("true");
    expect(screen.getByTestId("chat-voice-speaker-owner-crown")).toBeTruthy();
  });

  it("omits the badge when voiceSpeaker is absent", () => {
    render(<ChatMessage message={makeMessage()} />);
    expect(screen.queryByTestId("chat-message-voice-speaker-msg-1")).toBeNull();
  });

  it("does not render the badge for assistant messages", () => {
    render(
      <ChatMessage
        message={makeMessage({
          role: "assistant",
          voiceSpeaker: { name: "Alex" },
        })}
      />,
    );
    expect(screen.queryByTestId("chat-message-voice-speaker-msg-1")).toBeNull();
  });
});
