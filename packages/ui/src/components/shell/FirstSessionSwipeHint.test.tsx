/**
 * Exercises the swipe hint's once-only lifecycle against the real home
 * dismissal store, including completed, interrupted, and acted-on sessions.
 */
// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetHomeDismissalsForTests,
  __simulateNewSessionForTests,
} from "../../widgets/home-dismissal-store";
import {
  FirstSessionSwipeHint,
  SWIPE_HINT_DISPLAY_MS,
  SWIPE_HINT_FADE_MS,
  SWIPE_HINT_SHOW_DELAY_MS,
  SWIPE_HINT_WIDGET_KEY,
} from "./FirstSessionSwipeHint";

const HINT_TESTID = "first-session-swipe-hint";
const STORAGE_KEY = "eliza:home-dismissed:v1";

// jsdom has no matchMedia; FirstSessionSwipeHint treats that as a non-fine
// pointer (the touch case the hint exists for). Fine-pointer suppression gets
// an explicit matchMedia stub in its own test.
const originalMatchMedia = window.matchMedia;

function stubFinePointerMedia(): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches:
      query.includes("(hover: hover)") && query.includes("(pointer: fine)"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function persistedLifecycle(): {
  seen?: number;
  acted?: boolean;
  dismissed?: boolean;
} {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  return (JSON.parse(raw) as Record<string, Record<string, unknown>>)[
    SWIPE_HINT_WIDGET_KEY
  ] as { seen?: number; acted?: boolean; dismissed?: boolean };
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetHomeDismissalsForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  __resetHomeDismissalsForTests();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

describe("FirstSessionSwipeHint", () => {
  it("reveals once after the settle delay, fades, and dismisses permanently", () => {
    render(<FirstSessionSwipeHint page="home" />);

    // Nothing paints before the settle delay.
    expect(screen.queryByTestId(HINT_TESTID)).toBeNull();
    advance(SWIPE_HINT_SHOW_DELAY_MS - 1);
    expect(screen.queryByTestId(HINT_TESTID)).toBeNull();

    // Reveal: pill up, session counted, purely decorative chrome.
    advance(1);
    const hint = screen.getByTestId(HINT_TESTID);
    expect(hint.className).toContain("pointer-events-none");
    expect(hint.getAttribute("aria-hidden")).toBe("true");
    expect(hint.className).toContain("opacity-100");
    expect(persistedLifecycle().seen).toBe(1);

    // Display cycle ends: fade, then permanent dismissal.
    advance(SWIPE_HINT_DISPLAY_MS);
    expect(screen.getByTestId(HINT_TESTID).className).toContain("opacity-0");
    advance(SWIPE_HINT_FADE_MS);
    expect(screen.queryByTestId(HINT_TESTID)).toBeNull();
    expect(persistedLifecycle().dismissed).toBe(true);
  });

  it("never re-reveals after a completed display cycle, even on remount", () => {
    const first = render(<FirstSessionSwipeHint page="home" />);
    // Sequential advances: each timer in the reveal → display → fade chain is
    // armed by an effect that only flushes when its act() block ends.
    advance(SWIPE_HINT_SHOW_DELAY_MS);
    advance(SWIPE_HINT_DISPLAY_MS);
    advance(SWIPE_HINT_FADE_MS);
    expect(screen.queryByTestId(HINT_TESTID)).toBeNull();
    first.unmount();

    render(<FirstSessionSwipeHint page="home" />);
    advance(SWIPE_HINT_SHOW_DELAY_MS * 2);
    expect(screen.queryByTestId(HINT_TESTID)).toBeNull();
  });

  it("retires on a home → launcher flip before it ever paints", () => {
    const view = render(<FirstSessionSwipeHint page="home" />);
    advance(SWIPE_HINT_SHOW_DELAY_MS / 2);
    view.rerender(<FirstSessionSwipeHint page="launcher" />);
    expect(persistedLifecycle().acted).toBe(true);

    // Back on home, the lesson stays retired.
    view.rerender(<FirstSessionSwipeHint page="home" />);
    advance(SWIPE_HINT_SHOW_DELAY_MS * 2);
    expect(screen.queryByTestId(HINT_TESTID)).toBeNull();
  });

  it("hides mid-display the moment the user performs the swipe", () => {
    const view = render(<FirstSessionSwipeHint page="home" />);
    advance(SWIPE_HINT_SHOW_DELAY_MS);
    expect(screen.getByTestId(HINT_TESTID)).toBeTruthy();

    view.rerender(<FirstSessionSwipeHint page="launcher" />);
    expect(screen.queryByTestId(HINT_TESTID)).toBeNull();
    expect(persistedLifecycle().acted).toBe(true);

    view.rerender(<FirstSessionSwipeHint page="home" />);
    advance(SWIPE_HINT_SHOW_DELAY_MS * 2);
    expect(screen.queryByTestId(HINT_TESTID)).toBeNull();
  });

  it("does not count a route-driven launcher start as acting", () => {
    render(<FirstSessionSwipeHint page="launcher" />);
    advance(SWIPE_HINT_SHOW_DELAY_MS * 2);
    expect(persistedLifecycle().acted).not.toBe(true);
  });

  it("a session spent on the launcher half does not consume the showing", () => {
    const view = render(<FirstSessionSwipeHint page="launcher" />);
    advance(SWIPE_HINT_SHOW_DELAY_MS * 2);
    expect(persistedLifecycle().seen ?? 0).toBe(0);
    view.unmount();

    __simulateNewSessionForTests();
    render(<FirstSessionSwipeHint page="home" />);
    advance(SWIPE_HINT_SHOW_DELAY_MS);
    expect(screen.getByTestId(HINT_TESTID)).toBeTruthy();
  });

  it("never shows again in the next session, even after an interrupted first showing", () => {
    // Session 1: reveal, then the "tab closes" mid-display (unmount without
    // the display cycle completing — no dismissal recorded).
    const first = render(<FirstSessionSwipeHint page="home" />);
    advance(SWIPE_HINT_SHOW_DELAY_MS + 100);
    expect(screen.getByTestId(HINT_TESTID)).toBeTruthy();
    first.unmount();
    expect(persistedLifecycle().dismissed).not.toBe(true);

    // Session 2: the afterSeen: 1 sunset holds — no reveal at any point.
    __simulateNewSessionForTests();
    render(<FirstSessionSwipeHint page="home" />);
    advance(
      SWIPE_HINT_SHOW_DELAY_MS + SWIPE_HINT_DISPLAY_MS + SWIPE_HINT_FADE_MS,
    );
    expect(screen.queryByTestId(HINT_TESTID)).toBeNull();
  });

  it("never renders on fine-pointer devices (PagerEdgeButtons' complement)", () => {
    stubFinePointerMedia();
    render(<FirstSessionSwipeHint page="home" />);
    advance(SWIPE_HINT_SHOW_DELAY_MS * 2);
    expect(screen.queryByTestId(HINT_TESTID)).toBeNull();
    // The showing is not consumed either — a later touch session still teaches.
    expect(persistedLifecycle().seen ?? 0).toBe(0);
  });
});
