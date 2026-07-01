// @vitest-environment jsdom

// Touch tap-vs-scroll discrimination for the composite ChatMessage's
// tap-to-reveal action rail (copy/edit/play/delete). On non-hover devices the
// whole <article> toggles the rail on touchend; without move-slop tracking a
// flick-scroll over the transcript toggled the rail on whichever message the
// finger started on. The fix mirrors the shell ThreadLine: finger travel past
// the slop (TAP_REVEAL_MOVE_CANCEL_PX) cancels the toggle, and an active
// (non-collapsed) text selection suppresses it so ending a highlight drag
// never also flips the rail.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ChatMessage } from "./chat-message";
import type { ChatMessageData } from "./chat-types";

beforeAll(() => {
  // Simulate a touch-only device: the hover media query must NOT match so the
  // tap-to-reveal path (not mouse hover) drives the action rail. Installed
  // before the first render because ChatMessage caches the MediaQueryList.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
});

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

function getArticle(): HTMLElement {
  return screen.getByTestId("chat-message");
}

/**
 * The rail's visibility is carried by an opacity class on the wrapper around
 * ChatMessageActions (opacity-100 shown, opacity-0 hidden) — walk up from the
 * always-rendered Copy button to read it.
 */
function railVisible(): boolean {
  let el: HTMLElement | null = screen.getByLabelText("Copy message");
  while (el) {
    if (el.classList.contains("opacity-100")) return true;
    if (el.classList.contains("opacity-0")) return false;
    el = el.parentElement;
  }
  throw new Error("action-rail visibility wrapper not found");
}

function touchPoint(clientX: number, clientY: number) {
  return { clientX, clientY };
}

describe("ChatMessage tap-to-reveal vs transcript scroll", () => {
  it("a clean tap toggles the action rail on and off", () => {
    render(<ChatMessage message={makeMessage()} onCopy={vi.fn()} />);
    const article = getArticle();
    expect(railVisible()).toBe(false);

    // Tap with negligible travel (within the slop) reveals the rail.
    fireEvent.touchStart(article, { touches: [touchPoint(50, 100)] });
    fireEvent.touchEnd(article, { changedTouches: [touchPoint(52, 103)] });
    expect(railVisible()).toBe(true);

    // A second clean tap hides it again.
    fireEvent.touchStart(article, { touches: [touchPoint(50, 100)] });
    fireEvent.touchEnd(article, { changedTouches: [touchPoint(50, 100)] });
    expect(railVisible()).toBe(false);
  });

  it("a scroll-like touch (travel past the slop) does NOT toggle the rail", () => {
    render(<ChatMessage message={makeMessage()} onCopy={vi.fn()} />);
    const article = getArticle();

    // Vertical flick — the transcript scroll gesture.
    fireEvent.touchStart(article, { touches: [touchPoint(50, 100)] });
    fireEvent.touchEnd(article, { changedTouches: [touchPoint(50, 180)] });
    expect(railVisible()).toBe(false);

    // Horizontal drag past the slop is not a tap either.
    fireEvent.touchStart(article, { touches: [touchPoint(50, 100)] });
    fireEvent.touchEnd(article, { changedTouches: [touchPoint(90, 100)] });
    expect(railVisible()).toBe(false);

    // Once revealed by a clean tap, a scroll must not hide it either.
    fireEvent.touchStart(article, { touches: [touchPoint(50, 100)] });
    fireEvent.touchEnd(article, { changedTouches: [touchPoint(50, 100)] });
    expect(railVisible()).toBe(true);
    fireEvent.touchStart(article, { touches: [touchPoint(50, 100)] });
    fireEvent.touchEnd(article, { changedTouches: [touchPoint(50, 20)] });
    expect(railVisible()).toBe(true);
  });

  it("an active text selection suppresses the toggle; clearing it restores taps", () => {
    render(<ChatMessage message={makeMessage()} onCopy={vi.fn()} />);
    const article = getArticle();

    // Highlight the bubble text (a non-collapsed selection), as a finished
    // press-drag-select leaves behind.
    const bubbleText = screen.getByText("Here are your latest balances.");
    const range = document.createRange();
    range.selectNodeContents(bubbleText);
    const selection = window.getSelection();
    if (!selection) throw new Error("jsdom selection unavailable");
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.isCollapsed).toBe(false);

    // The tap that ends the highlight must not also flip the rail.
    fireEvent.touchStart(article, { touches: [touchPoint(50, 100)] });
    fireEvent.touchEnd(article, { changedTouches: [touchPoint(50, 100)] });
    expect(railVisible()).toBe(false);

    // With the selection cleared, tapping works again.
    selection.removeAllRanges();
    fireEvent.touchStart(article, { touches: [touchPoint(50, 100)] });
    fireEvent.touchEnd(article, { changedTouches: [touchPoint(50, 100)] });
    expect(railVisible()).toBe(true);
  });
});
