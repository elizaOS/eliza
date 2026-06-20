// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    role: "assistant",
    text: "Want me to pull your latest balances?",
    ...overrides,
  };
}

describe("ChatMessage proactive suggestion affordance (#8792)", () => {
  it("renders a distinct Suggestion affordance for source proactive-interaction", () => {
    render(
      <ChatMessage
        message={makeMessage({ source: "proactive-interaction" })}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Suggestion")).toBeTruthy();
    expect(
      document.querySelector('[data-proactive-suggestion="true"]'),
    ).toBeTruthy();
  });

  it("does NOT render the suggestion affordance for a normal assistant reply", () => {
    render(<ChatMessage message={makeMessage()} onDelete={vi.fn()} />);
    expect(screen.queryByText("Suggestion")).toBeNull();
    expect(
      document.querySelector('[data-proactive-suggestion="true"]'),
    ).toBeNull();
  });

  it("offers a one-tap dismiss that removes the suggestion by id", () => {
    const onDelete = vi.fn();
    render(
      <ChatMessage
        message={makeMessage({ source: "proactive-interaction" })}
        onDelete={onDelete}
      />,
    );
    const dismiss = screen.getByLabelText("Dismiss suggestion");
    fireEvent.click(dismiss);
    expect(onDelete).toHaveBeenCalledWith("msg-1");
  });

  it("does not treat a user message with the source as a suggestion", () => {
    render(
      <ChatMessage
        message={makeMessage({ role: "user", source: "proactive-interaction" })}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByText("Suggestion")).toBeNull();
  });
});
