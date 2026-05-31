// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatSurface } from "../ChatSurface";
import type { ShellMessage } from "../shell-state";

afterEach(() => cleanup());

describe("ChatSurface", () => {
  it("renders the greeting when there are no messages", () => {
    render(
      <ChatSurface
        messages={[]}
        onSend={() => {}}
        canSend={true}
        greeting="Good morning! What would you like to do?"
      />,
    );
    expect(
      screen.getByText("Good morning! What would you like to do?"),
    ).toBeTruthy();
  });

  it("renders bubbles for prior messages", () => {
    const messages: ShellMessage[] = [
      {
        id: "1",
        role: "user",
        content: "Remind me to call Alex at 3pm",
        createdAt: 0,
      },
      {
        id: "2",
        role: "assistant",
        content: "Done — reminder set for 3:00 PM.",
        createdAt: 0,
      },
    ];
    render(
      <ChatSurface messages={messages} onSend={() => {}} canSend={true} />,
    );
    expect(screen.getByText("Remind me to call Alex at 3pm")).toBeTruthy();
    expect(screen.getByText(/Done — reminder set/)).toBeTruthy();
  });

  it("disables send when input is empty", () => {
    render(<ChatSurface messages={[]} onSend={() => {}} canSend={true} />);
    expect(
      (
        screen.getByRole("button", {
          name: "Send message",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("enables send when input has text and calls onSend", () => {
    const onSend = vi.fn();
    render(<ChatSurface messages={[]} onSend={onSend} canSend={true} />);
    const input = screen.getByPlaceholderText(/ask eliza/i);
    fireEvent.change(input, { target: { value: "Hi" } });
    const send = screen.getByRole("button", {
      name: /send/i,
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith("Hi");
  });

  it("clears the input after a successful send", () => {
    render(<ChatSurface messages={[]} onSend={() => {}} canSend={true} />);
    const input = screen.getByPlaceholderText(/ask eliza/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(input.value).toBe("");
  });

  it("disables the input + send when canSend=false", () => {
    render(<ChatSurface messages={[]} onSend={() => {}} canSend={false} />);
    expect(
      (screen.getByPlaceholderText(/ask eliza/i) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /send/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("renders a disabled voice toggle when no voice handler is provided", () => {
    render(<ChatSurface messages={[]} onSend={() => {}} canSend={true} />);
    const voiceToggle = screen.getByRole("button", {
      name: /voice input/i,
    }) as HTMLButtonElement;
    expect(voiceToggle.disabled).toBe(true);
    expect(voiceToggle.querySelector("svg")).not.toBeNull();
  });

  it("enables the voice toggle and toggles voice capture when wired", () => {
    const onToggleRecording = vi.fn();
    render(
      <ChatSurface
        messages={[]}
        onSend={() => {}}
        canSend={true}
        onToggleRecording={onToggleRecording}
      />,
    );
    const voiceToggle = screen.getByRole("button", {
      name: /start voice input/i,
    }) as HTMLButtonElement;
    expect(voiceToggle.disabled).toBe(false);
    expect(voiceToggle.querySelector("svg")).not.toBeNull();
    const input = screen.getByLabelText("Message Eliza");
    expect(
      input.compareDocumentPosition(voiceToggle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(voiceToggle);
    expect(onToggleRecording).toHaveBeenCalledTimes(1);
  });

  it("submits on Enter (without Shift)", () => {
    const onSend = vi.fn();
    render(<ChatSurface messages={[]} onSend={onSend} canSend={true} />);
    const input = screen.getByPlaceholderText(/ask eliza/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "From keyboard" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("From keyboard");
    expect(input.value).toBe("");
  });

  it("does not submit on Shift+Enter", () => {
    const onSend = vi.fn();
    render(<ChatSurface messages={[]} onSend={onSend} canSend={true} />);
    const input = screen.getByPlaceholderText(/ask eliza/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Draft" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("Draft");
  });

  it("renders a typing indicator for an empty assistant placeholder", () => {
    const messages: ShellMessage[] = [
      { id: "u", role: "user", content: "Hi", createdAt: 0 },
      { id: "a", role: "assistant", content: "", createdAt: 1 },
    ];
    render(
      <ChatSurface messages={messages} onSend={() => {}} canSend={true} />,
    );
    const typing = screen.getByLabelText(/eliza is typing/i);
    expect(typing).toBeTruthy();
  });

  it("marks the conversation list as a polite aria-live region for streaming announcements", () => {
    const messages: ShellMessage[] = [
      { id: "u", role: "user", content: "Hi", createdAt: 0 },
      { id: "a", role: "assistant", content: "Hello", createdAt: 1 },
    ];
    render(
      <ChatSurface messages={messages} onSend={() => {}} canSend={true} />,
    );
    const list = screen.getByRole("list");
    expect(list.getAttribute("aria-live")).toBe("polite");
    expect(list.getAttribute("aria-atomic")).toBe("false");
  });
});
