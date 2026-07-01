// @vitest-environment jsdom
//
// The desktop hover action rail's Copy button fires `onCopy` (which the
// ChatView wires to the clipboard helper) and reflects the copied state in its
// label. This closes the coverage gap called out in #9148 — the overlay copy
// was tested but the desktop ChatMessageActions copy was not.
//
// The Play (TTS) and Edit buttons were previously untested at both the
// presentational level (this component only renders the button when the
// capability is enabled and forwards the click to the callback) AND at the
// wiring level (ChatMessage computes canPlay/canEdit and passes the real
// TTS/edit-mode handlers). Both layers are exercised below.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessage } from "./chat-message";
import { ChatMessageActions } from "./chat-message-actions";
import type { ChatMessageData } from "./chat-types";

afterEach(cleanup);

describe("ChatMessageActions copy", () => {
  it("invokes onCopy when the copy button is clicked", async () => {
    const onCopy = vi.fn();
    render(<ChatMessageActions onCopy={onCopy} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy message" }));
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it("reflects the copied state in the button label", () => {
    render(<ChatMessageActions copied onCopy={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Copied to clipboard" }),
    ).toBeTruthy();
  });

  it("uses provided copy labels when supplied", () => {
    render(
      <ChatMessageActions
        onCopy={vi.fn()}
        labels={{ copy: "Copy text", copiedAria: "Done" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Copy text" })).toBeTruthy();
  });

  it("invokes onDelete when the delete button is enabled and clicked", async () => {
    const onDelete = vi.fn();
    render(<ChatMessageActions canDelete onDelete={onDelete} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Delete message" }),
    );
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe("ChatMessageActions play (TTS)", () => {
  it("does not render the play button when canPlay is false", () => {
    const onPlay = vi.fn();
    render(<ChatMessageActions onPlay={onPlay} onCopy={vi.fn()} />);
    // The capability is off (default), so there is no affordance to trigger
    // TTS and the callback can never fire.
    expect(screen.queryByRole("button", { name: "Play message" })).toBeNull();
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("fires onPlay exactly once per click when canPlay is enabled", async () => {
    const onPlay = vi.fn();
    render(<ChatMessageActions canPlay onPlay={onPlay} onCopy={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Play message" }));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it("forwards every rapid click to onPlay (no internal debounce/dedup)", async () => {
    // The rail is a dumb forwarder: a user hammering Play must not have clicks
    // silently swallowed here — dedup, if any, is the TTS service's job.
    const onPlay = vi.fn();
    render(<ChatMessageActions canPlay onPlay={onPlay} onCopy={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Play message" });
    await userEvent.click(button);
    await userEvent.click(button);
    await userEvent.click(button);
    expect(onPlay).toHaveBeenCalledTimes(3);
  });

  it("uses the provided play label", () => {
    render(
      <ChatMessageActions
        canPlay
        onPlay={vi.fn()}
        onCopy={vi.fn()}
        labels={{ play: "Speak it" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Speak it" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Play message" })).toBeNull();
  });

  it("does not throw when the play button is clicked with no onPlay handler", async () => {
    // canPlay can be true while onPlay is momentarily undefined (e.g. handler
    // not yet wired) — clicking must be an inert no-op, never a crash.
    render(<ChatMessageActions canPlay onCopy={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Play message" });
    await userEvent.click(button);
    expect(button.isConnected).toBe(true);
  });
});

describe("ChatMessageActions edit", () => {
  it("does not render the edit button when canEdit is false", () => {
    const onEdit = vi.fn();
    render(<ChatMessageActions onEdit={onEdit} onCopy={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("fires onEdit exactly once per click when canEdit is enabled", async () => {
    const onEdit = vi.fn();
    render(<ChatMessageActions canEdit onEdit={onEdit} onCopy={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit message" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("uses the provided edit label", () => {
    render(
      <ChatMessageActions
        canEdit
        onEdit={vi.fn()}
        onCopy={vi.fn()}
        labels={{ edit: "Revise" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Revise" })).toBeTruthy();
  });

  it("renders play, edit and delete independently based on each capability flag", () => {
    // Only the delete capability is on: the other two affordances stay absent
    // so a message that only allows deletion can't be spoken or edited.
    render(
      <ChatMessageActions
        canDelete
        onPlay={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Delete message" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Play message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
  });
});

// -- Wiring layer: ChatMessage computes the capabilities + supplies the real
//    TTS payload and edit-mode transition that the rail merely triggers. These
//    prove the button click reaches the message-scoped behavior, not just a spy.
function makeMessage(
  overrides: Partial<ChatMessageData> = {},
): ChatMessageData {
  return { id: "msg-1", role: "user", text: "hello there", ...overrides };
}

// The rail lives inside the bubble and is opacity/pointer-events gated until the
// row is hovered; reveal it the way a real pointer would before interacting.
function revealActions(): void {
  const article = document.querySelector("article");
  if (!article) throw new Error("chat message article not rendered");
  fireEvent.mouseEnter(article);
}

describe("ChatMessage → actions wiring", () => {
  it("Play speaks the exact message id + text via onSpeak", async () => {
    const onSpeak = vi.fn();
    render(
      <ChatMessage
        message={makeMessage({
          id: "agent-7",
          role: "agent",
          text: "the answer is 42",
        })}
        onSpeak={onSpeak}
      />,
    );
    revealActions();
    await userEvent.click(screen.getByRole("button", { name: "Play message" }));
    expect(onSpeak).toHaveBeenCalledTimes(1);
    expect(onSpeak).toHaveBeenCalledWith("agent-7", "the answer is 42");
  });

  it("does not offer Play for an agent message whose text is only whitespace", () => {
    // canPlay requires non-empty trimmed text — an empty streamed bubble must
    // not present a TTS button that would speak nothing.
    const onSpeak = vi.fn();
    render(
      <ChatMessage
        message={makeMessage({ id: "agent-8", role: "agent", text: "   " })}
        onSpeak={onSpeak}
      />,
    );
    revealActions();
    expect(screen.queryByRole("button", { name: "Play message" })).toBeNull();
    expect(onSpeak).not.toHaveBeenCalled();
  });

  it("Edit enters edit mode with the message text as the draft", async () => {
    const onEdit = vi.fn();
    render(
      <ChatMessage
        message={makeMessage({ id: "user-3", text: "original draft" })}
        onEdit={onEdit}
      />,
    );
    revealActions();
    await userEvent.click(screen.getByRole("button", { name: "Edit message" }));
    // Entering edit mode swaps the bubble content for a textarea seeded with
    // the current message text — the edit callback itself only fires on save.
    const textarea = document.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect((textarea as HTMLTextAreaElement).value).toBe("original draft");
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("does not offer Edit for an optimistic temp- message", () => {
    // Optimistic sends carry a temp- id and no server row yet; editing one
    // would target a message that does not exist, so the affordance is hidden.
    const onEdit = vi.fn();
    render(
      <ChatMessage
        message={makeMessage({ id: "temp-123", text: "sending..." })}
        onEdit={onEdit}
      />,
    );
    revealActions();
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("does not offer Edit on an agent message even when onEdit is supplied", () => {
    // Only the user's own messages are editable; an agent turn stays read-only.
    const onEdit = vi.fn();
    render(
      <ChatMessage
        message={makeMessage({ id: "agent-9", role: "agent", text: "hi" })}
        onEdit={onEdit}
        onSpeak={vi.fn()}
      />,
    );
    revealActions();
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
  });
});
