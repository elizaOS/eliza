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
});
