// @vitest-environment jsdom

/**
 * Desktop hover coverage for the per-message delete control. The test runs in
 * its own file because ChatMessage caches the hover MediaQueryList at module
 * scope, so a sibling touch-suite install would otherwise poison the device
 * branch under test.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ChatMessage } from "./chat-message";
import type { ChatMessageData } from "./chat-types";

beforeAll(() => {
  // Hover device: `(hover: hover) and (pointer: fine)` matches so ChatMessage
  // takes the pointer (panel-rail) chrome, not the touch tap-reveal chrome.
  // Installed before the first render because the MediaQueryList is cached on
  // first read.
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
    role: "assistant",
    text: "Here are your latest balances.",
    ...overrides,
  };
}

function deleteControl(): HTMLElement | null {
  return screen.queryByRole("button", { name: "Delete message" });
}

describe("ChatMessage desktop hover-chrome delete control (#13533)", () => {
  it("reveals the delete control on desktop hover when the surface wires onDelete", () => {
    render(
      <ChatMessage
        message={makeMessage()}
        onCopy={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const message = screen.getByTestId("chat-message");
    const rail = screen.getByTestId("chat-message-action-rail");

    expect(deleteControl()).not.toBeNull();
    expect(rail.className).toContain("pointer-events-none");
    expect(rail.className).toContain("opacity-0");

    fireEvent.mouseEnter(message);

    expect(rail.className).not.toContain("pointer-events-none");
    expect(rail.className).toContain("opacity-100");

    fireEvent.mouseLeave(message);

    expect(rail.className).toContain("pointer-events-none");
    expect(rail.className).toContain("opacity-0");
  });

  it("omits the delete control when the surface wires no onDelete", () => {
    render(<ChatMessage message={makeMessage()} onCopy={vi.fn()} />);
    expect(deleteControl()).toBeNull();
  });

  it("omits the delete control on an optimistic (temp-) turn even with onDelete wired", () => {
    render(
      <ChatMessage
        message={makeMessage({ id: "temp-123" })}
        onCopy={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    // A temp turn has no persisted memory row to delete; ChatMessage's canDelete
    // guard excludes `temp-` ids so the control never appears on it.
    expect(deleteControl()).toBeNull();
  });

  it("renders a plain first-run greeting (no bubble box) with no action rail", () => {
    // The onboarding greeting is seeded wallpaper prose with a CTA beneath it;
    // reply / copy / delete / play are meaningless on it and the hover rail read
    // as a bug during first-run. Even with every action handler wired, a
    // `first_run` source turn must render no rail — and no bubble box (it floats
    // as plain text on the takeover/glass, like every other chat turn).
    render(
      <ChatMessage
        message={makeMessage({ source: "first_run", text: "Welcome aboard" })}
        appearance="glass"
        onCopy={vi.fn()}
        onDelete={vi.fn()}
        onReply={vi.fn()}
        onSpeak={vi.fn()}
      />,
    );
    // No boxed bubble: nothing in the row carries the old frosted-card frame.
    const boxed = Array.from(
      document.querySelectorAll<HTMLElement>("div"),
    ).find(
      (el) =>
        el.classList.contains("bg-black/35") ||
        el.classList.contains("backdrop-blur-md"),
    );
    expect(boxed).toBeUndefined();
    expect(screen.getByText("Welcome aboard")).toBeTruthy();
    expect(screen.queryByTestId("chat-message-action-rail")).toBeNull();
    expect(deleteControl()).toBeNull();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  it("renders user turns as plain right-aligned text, no bubble box", () => {
    render(
      <ChatMessage
        message={makeMessage({ role: "user", text: "My message" })}
        appearance="glass"
      />,
    );
    const bubble = screen.getByText("My message").parentElement;
    // The chat is clean text over the glass sheet — no bubble border or box that
    // would nest a card inside the sheet.
    expect(bubble?.classList.contains("rounded-2xl")).toBe(false);
    expect(bubble?.classList.contains("border-white/15")).toBe(false);
    expect(bubble?.classList.contains("py-1")).toBe(true);
    // Right alignment (not a box) is what distinguishes an authored turn.
    const row = screen.getByTestId("thread-line");
    expect(row.getAttribute("data-role")).toBe("user");
  });
});
