// @vitest-environment jsdom
//
// End-to-end open→send→close flow across the shell trio (HomePill +
// AssistantOverlay + ChatSurface) wired through a local phase/message harness:
// open from the pill, send by button and Enter, keep real output visible, and
// close with Escape/pill restoring focus. Real components in jsdom, no server.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssistantOverlay } from "../AssistantOverlay";
import { ChatSurface } from "../ChatSurface";
import { HomePill } from "../HomePill";
import type { ShellMessage, ShellPhase } from "../shell-state";

afterEach(() => cleanup());

function ShellAssistantHarness({
  onSend = () => {},
}: {
  onSend?: (text: string) => void;
}) {
  const [phase, setPhase] = React.useState<ShellPhase>("idle");
  const [messages, setMessages] = React.useState<ShellMessage[]>([]);

  function send(text: string) {
    onSend(text);
    setMessages((current) => [
      ...current,
      {
        id: `user-${current.length}`,
        role: "user",
        content: text,
        createdAt: 1,
      },
      {
        id: `assistant-${current.length}`,
        role: "assistant",
        content: `Echo: ${text}`,
        createdAt: 2,
      },
    ]);
  }

  return (
    <>
      <HomePill
        phase={phase}
        onOpen={() => setPhase("summoned")}
        onClose={() => setPhase("idle")}
      />
      <AssistantOverlay phase={phase} onClose={() => setPhase("idle")}>
        <ChatSurface messages={messages} onSend={send} canSend={true} />
      </AssistantOverlay>
    </>
  );
}

describe("shell assistant end-to-end flow", () => {
  it("opens the assistant chat input from the home pill and closes it from the pill", () => {
    render(<ShellAssistantHarness />);

    const pill = screen.getByTestId("shell-home-pill");
    expect(pill.getAttribute("aria-label")).toBe("Open Eliza");
    expect(screen.queryByTestId("shell-assistant-overlay")).toBeNull();
    expect(screen.queryByLabelText(/message eliza/i)).toBeNull();

    fireEvent.click(pill);

    expect(screen.getByTestId("shell-assistant-overlay")).toBeTruthy();
    expect(
      screen.getByRole("dialog", { name: /eliza assistant/i }),
    ).toBeTruthy();
    expect(screen.getByLabelText(/message eliza/i)).toBeTruthy();
    expect(pill.getAttribute("aria-label")).toBe("Close Eliza");
    expect(pill.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(pill);

    expect(screen.queryByTestId("shell-assistant-overlay")).toBeNull();
    expect(screen.queryByLabelText(/message eliza/i)).toBeNull();
    expect(pill.getAttribute("aria-label")).toBe("Open Eliza");
    expect(pill.getAttribute("aria-pressed")).toBe("false");
  });

  it("sends a message through the opened chat surface and keeps the real output visible", () => {
    const onSend = vi.fn();
    render(<ShellAssistantHarness onSend={onSend} />);

    fireEvent.click(screen.getByTestId("shell-home-pill"));
    const input = screen.getByLabelText(/message eliza/i) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: "validate the window manager" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSend).toHaveBeenCalledWith("validate the window manager");
    expect(input.value).toBe("");
    expect(screen.getByText("validate the window manager")).toBeTruthy();
    expect(screen.getByText("Echo: validate the window manager")).toBeTruthy();
  });

  it("submits with Enter through the opened chat input and keeps the overlay open", () => {
    const onSend = vi.fn();
    render(<ShellAssistantHarness onSend={onSend} />);

    fireEvent.click(screen.getByTestId("shell-home-pill"));
    const input = screen.getByLabelText(/message eliza/i) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: "create the local notes view" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("create the local notes view");
    expect(input.value).toBe("");
    expect(screen.getByTestId("shell-assistant-overlay")).toBeTruthy();
    expect(screen.getByText("create the local notes view")).toBeTruthy();
    expect(screen.getByText("Echo: create the local notes view")).toBeTruthy();
  });

  it("closes the opened chat input with Escape and restores focus to the pill", () => {
    render(<ShellAssistantHarness />);

    const pill = screen.getByTestId("shell-home-pill");
    pill.focus();
    fireEvent.click(pill);
    expect(screen.getByTestId("shell-assistant-overlay")).toBeTruthy();
    expect(screen.getByLabelText(/message eliza/i)).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByTestId("shell-assistant-overlay")).toBeNull();
    expect(screen.queryByLabelText(/message eliza/i)).toBeNull();
    expect(pill.getAttribute("aria-label")).toBe("Open Eliza");
    expect(document.activeElement).toBe(pill);
  });
});
