// @vitest-environment jsdom
/**
 * Renders ChatMessage in jsdom and asserts the proactive-suggestion affordance
 * (#8792): it appears only for the proactive-interaction source on an assistant
 * turn, offers one-tap dismiss and accept ("Do it"), and stays hidden without
 * the corresponding handlers. RTL, no live model.
 */

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
        onDismissSuggestion={vi.fn()}
      />,
    );
    expect(screen.getByText("Suggestion")).toBeTruthy();
    expect(
      document.querySelector('[data-proactive-suggestion="true"]'),
    ).toBeTruthy();
  });

  it("does NOT render the suggestion affordance for a normal assistant reply", () => {
    render(
      <ChatMessage message={makeMessage()} onDismissSuggestion={vi.fn()} />,
    );
    expect(screen.queryByText("Suggestion")).toBeNull();
    expect(
      document.querySelector('[data-proactive-suggestion="true"]'),
    ).toBeNull();
  });

  it("offers a one-tap dismiss that removes the suggestion by id", () => {
    const onDismissSuggestion = vi.fn();
    render(
      <ChatMessage
        message={makeMessage({ source: "proactive-interaction" })}
        onDismissSuggestion={onDismissSuggestion}
      />,
    );
    fireEvent.click(screen.getByLabelText("Dismiss suggestion"));
    expect(onDismissSuggestion).toHaveBeenCalledWith("msg-1");
  });

  it("offers an accept ('Do it') affordance that sends the implied action", () => {
    const onAcceptSuggestion = vi.fn();
    const message = makeMessage({ source: "proactive-interaction" });
    render(
      <ChatMessage
        message={message}
        onAcceptSuggestion={onAcceptSuggestion}
        onDismissSuggestion={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Do it"));
    expect(onAcceptSuggestion).toHaveBeenCalledWith(message);
  });

  it("does not render dismiss/accept controls without their handlers", () => {
    render(
      <ChatMessage
        message={makeMessage({ source: "proactive-interaction" })}
      />,
    );
    // The eyebrow still renders, but neither control appears without a handler.
    expect(screen.getByText("Suggestion")).toBeTruthy();
    expect(screen.queryByLabelText("Dismiss suggestion")).toBeNull();
    expect(screen.queryByLabelText("Do it")).toBeNull();
  });

  it("does not treat a user message with the source as a suggestion", () => {
    render(
      <ChatMessage
        message={makeMessage({ role: "user", source: "proactive-interaction" })}
        onDismissSuggestion={vi.fn()}
      />,
    );
    expect(screen.queryByText("Suggestion")).toBeNull();
  });
});
