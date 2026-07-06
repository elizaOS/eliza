// @vitest-environment jsdom

/**
 * The per-message Reply affordance and the "Replying to …" pill. Runs in its own
 * file because ChatMessage caches the hover MediaQueryList at module scope; a
 * sibling touch-suite install would poison the panel-rail branch under test.
 * Deterministic — renders the real components; asserts the callback payload and
 * the pill's identify/cancel behavior, no live surface or send path.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildReplyTargetFromMessage, ChatMessage } from "./chat-message";
import { ChatReplyPill } from "./chat-reply-pill";
import type { ChatMessageData } from "./chat-types";

beforeAll(() => {
  // Hover device so ChatMessage takes the panel-rail chrome (not tap-reveal).
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(cleanup);

function makeMessage(
  overrides: Partial<ChatMessageData> = {},
): ChatMessageData {
  return {
    id: "msg-1",
    role: "user",
    from: "Alice",
    text: "Can you book the 3pm slot?",
    ...overrides,
  };
}

function replyControl(): HTMLElement | null {
  return screen.queryByTestId("chat-message-reply");
}

describe("ChatMessage Reply affordance", () => {
  it("reveals a Reply control and passes the message to onReply", () => {
    const onReply = vi.fn();
    render(<ChatMessage message={makeMessage()} onReply={onReply} />);

    const control = replyControl();
    expect(control).not.toBeNull();
    fireEvent.click(control as HTMLElement);

    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply.mock.calls[0][0].id).toBe("msg-1");
  });

  it("omits Reply when the surface wires no onReply", () => {
    render(<ChatMessage message={makeMessage()} onCopy={vi.fn()} />);
    expect(replyControl()).toBeNull();
  });

  it("omits Reply on an optimistic (temp-) turn — no persisted row to target", () => {
    render(
      <ChatMessage message={makeMessage({ id: "temp-9" })} onReply={vi.fn()} />,
    );
    expect(replyControl()).toBeNull();
  });

  it("omits Reply on a proactive suggestion (its own affordances apply)", () => {
    render(
      <ChatMessage
        message={makeMessage({
          role: "assistant",
          source: "proactive-interaction",
        })}
        onReply={vi.fn()}
      />,
    );
    expect(replyControl()).toBeNull();
  });
});

describe("buildReplyTargetFromMessage", () => {
  it("labels a user turn by its sender and caps the snippet", () => {
    const target = buildReplyTargetFromMessage(
      makeMessage({ text: "  spaced\nout   text  " }),
      "Eliza",
    );
    expect(target.messageId).toBe("msg-1");
    expect(target.senderName).toBe("Alice");
    expect(target.snippet).toBe("spaced out text");
  });

  it("labels an assistant turn by the agent name", () => {
    const target = buildReplyTargetFromMessage(
      makeMessage({ role: "assistant", from: undefined, text: "Done." }),
      "Eliza",
    );
    expect(target.senderName).toBe("Eliza");
  });
});

describe("ChatReplyPill", () => {
  it("identifies the target and fires cancel", () => {
    const onCancel = vi.fn();
    render(
      <ChatReplyPill
        target={{
          messageId: "msg-1",
          senderName: "Alice",
          snippet: "Can you book the 3pm slot?",
        }}
        onCancel={onCancel}
      />,
    );

    const pill = screen.getByTestId("chat-reply-pill");
    expect(pill.textContent).toContain("Replying to Alice");
    expect(pill.textContent).toContain("Can you book the 3pm slot?");

    fireEvent.click(screen.getByTestId("chat-reply-pill-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
