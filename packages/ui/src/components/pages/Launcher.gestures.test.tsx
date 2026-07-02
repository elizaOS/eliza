// @vitest-environment jsdom
//
// SCOPE (honest labelling, #10722): this is the Launcher's SWIPE-PAGING unit
// suite. The Launcher is READ-ONLY (no reorder, no edit mode, no persisted
// layout — page composition is owned by `curateLauncherPages`), so the only
// gestures it owns are the horizontal page swipe (via `useHorizontalPager`) and
// the tap-to-launch. This suite drives the REAL pointer handlers on
// `launcher-page-window` — there is no motion/react mock — so it exercises the
// actual swipe threshold / flick / clamp / touch-capture-guard bridge. jsdom
// cannot run the settle animation to completion, so the assertions read the
// committed page's `aria-hidden` + the emitted telemetry, not the tween. The
// real-motion render path (page dots, image tiles) is covered by the sibling
// Launcher.test.tsx; the genuine CDP pointer-drag swipe is section of the
// isolated-browser runner (`bun run --cwd packages/ui test:launcher-e2e`).

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewEntry } from "../../hooks/view-catalog";
import {
  readViewInteractions,
  type ViewInteractionAction,
} from "../../view-telemetry";
import { Launcher } from "./Launcher";

const originalMatchMedia = window.matchMedia;

function entry(id: string, label: string): ViewEntry {
  return {
    key: `view:${id}`,
    id,
    label,
    icon: "LayoutGrid",
    hasHero: false,
    modality: "gui",
    state: "loaded",
    kind: "view",
    viewKind: "release",
  } as ViewEntry;
}

function clearTelemetry() {
  (
    globalThis as { __ELIZA_VIEW_INTERACTION_TELEMETRY__?: unknown[] }
  ).__ELIZA_VIEW_INTERACTION_TELEMETRY__ = [];
}

function mockDesktopPagingMedia({
  finePointer,
}: {
  finePointer: boolean;
}): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches:
      finePointer &&
      query.includes("(hover: hover)") &&
      query.includes("(pointer: fine)"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function actions(): ViewInteractionAction[] {
  return readViewInteractions().map((e) => e.action);
}

function horizontalSwipe(dx: number): void {
  const pageWindow = screen.getByTestId("launcher-page-window");
  fireEvent.pointerDown(pageWindow, {
    pointerId: 1,
    clientX: 500,
    clientY: 100,
    isPrimary: true,
  });
  fireEvent.pointerMove(pageWindow, {
    pointerId: 1,
    clientX: 500 + dx,
    clientY: 102,
    isPrimary: true,
  });
  fireEvent.pointerUp(pageWindow, {
    pointerId: 1,
    clientX: 500 + dx,
    clientY: 102,
    isPrimary: true,
  });
}

// Two curated pages: page 0 holds v0..v19, page 1 holds v20..v24. Each group is
// its own page (the launcher never chunks a single group across pages), so a
// two-group `pageGroups` is what produces a swipeable two-page launcher.
const PAGE2 = Array.from({ length: 25 }, (_, i) => entry(`v${i}`, `View ${i}`));
const PAGE2_GROUPS: string[][] = [
  Array.from({ length: 20 }, (_, i) => `v${i}`),
  Array.from({ length: 5 }, (_, i) => `v${20 + i}`),
];

beforeEach(() => {
  mockDesktopPagingMedia({ finePointer: false });
  window.localStorage.clear();
  clearTelemetry();
});
afterEach(() => {
  cleanup();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

describe("Launcher swipe paging", () => {
  it("advances a page past the swipe threshold and emits page-swipe", () => {
    render(
      <Launcher
        entries={PAGE2}
        pageGroups={PAGE2_GROUPS}
        onLaunch={() => {}}
      />,
    );
    expect(
      screen.getByTestId("launcher-page-0").getAttribute("aria-hidden"),
    ).toBe("false");
    expect(
      screen.getByTestId("launcher-page-1").getAttribute("aria-hidden"),
    ).toBe("true");
    act(() => {
      horizontalSwipe(-300);
    });
    // Page 1 now shows v20..v24.
    expect(
      screen.getByTestId("launcher-page-1").getAttribute("aria-hidden"),
    ).toBe("false");
    expect(actions()).toContain("page-swipe");
  });

  it("ignores a drag below the threshold", () => {
    render(
      <Launcher
        entries={PAGE2}
        pageGroups={PAGE2_GROUPS}
        onLaunch={() => {}}
      />,
    );
    act(() => {
      horizontalSwipe(-30);
    });
    expect(
      screen.getByTestId("launcher-page-1").getAttribute("aria-hidden"),
    ).toBe("true");
    expect(actions()).not.toContain("page-swipe");
  });

  it("clamps at the first page (no underflow)", () => {
    render(
      <Launcher
        entries={PAGE2}
        pageGroups={PAGE2_GROUPS}
        onLaunch={() => {}}
      />,
    );
    // Already on page 0; a rightward swipe would go to -1 → clamped, no event.
    act(() => {
      horizontalSwipe(300);
    });
    expect(actions()).not.toContain("page-swipe");
  });

  it("hides pager edge buttons when the pointer is coarse", () => {
    mockDesktopPagingMedia({ finePointer: false });
    render(
      <Launcher
        entries={PAGE2}
        pageGroups={PAGE2_GROUPS}
        onLaunch={() => {}}
      />,
    );

    expect(screen.queryByTestId("launcher-pager-edge-prev")).toBeNull();
    expect(screen.queryByTestId("launcher-pager-edge-next")).toBeNull();
  });

  it("shows pager edge buttons on any fine-pointer window — the gate has no min-width clause", () => {
    mockDesktopPagingMedia({ finePointer: true });
    render(
      <Launcher
        entries={PAGE2}
        pageGroups={PAGE2_GROUPS}
        onLaunch={() => {}}
      />,
    );

    // Fine pointer + hover is sufficient: a sub-1024px window still gets the
    // `>` control (production renders no page dots, so without it a narrow
    // fine-pointer window would have no paging affordance at all).
    expect(screen.queryByTestId("launcher-pager-edge-next")).not.toBeNull();
    expect(window.matchMedia).toHaveBeenCalledWith(
      expect.not.stringContaining("min-width"),
    );
  });

  it("shows desktop edge buttons and pages exactly one step per click", () => {
    mockDesktopPagingMedia({ finePointer: true });
    render(
      <Launcher
        entries={PAGE2}
        pageGroups={PAGE2_GROUPS}
        onLaunch={() => {}}
      />,
    );

    expect(screen.queryByTestId("launcher-pager-edge-prev")).toBeNull();
    fireEvent.click(screen.getByTestId("launcher-pager-edge-next"));

    expect(
      screen.getByTestId("launcher-page-1").getAttribute("aria-hidden"),
    ).toBe("false");
    expect(actions()).toContain("page-swipe");
    expect(screen.queryByTestId("launcher-pager-edge-next")).toBeNull();

    fireEvent.click(screen.getByTestId("launcher-pager-edge-prev"));
    expect(
      screen.getByTestId("launcher-page-0").getAttribute("aria-hidden"),
    ).toBe("false");
  });
});

describe("Launcher touch swipe (Android WebView pointer-capture guard)", () => {
  // Reproduces the launcher-swipe regression seen on a real Pixel: on Android
  // WebView, calling setPointerCapture on a TOUCH pointer mid-gesture makes the
  // browser fire `pointercancel`, which the pager's onLostPointerCapture /
  // onPointerCancel turns into an aborted drag — the flick silently snaps back
  // and never reaches the apps page. The fix skips explicit capture for touch
  // (touch pointers are implicitly captured to the target), so the cancel never
  // fires.
  function touchSwipeWithCaptureCancel(dx: number): { captureCalls: number } {
    const pageWindow = screen.getByTestId("launcher-page-window");
    let captureCalls = 0;
    (pageWindow as HTMLElement).setPointerCapture = (pointerId: number) => {
      captureCalls += 1;
      // Mirror the WebView: an explicit capture on a live touch is answered with
      // a pointercancel.
      fireEvent.pointerCancel(pageWindow, {
        pointerId,
        pointerType: "touch",
        isPrimary: true,
      });
    };
    (pageWindow as HTMLElement).releasePointerCapture = () => {};
    fireEvent.pointerDown(pageWindow, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 500,
      clientY: 100,
      isPrimary: true,
    });
    fireEvent.pointerMove(pageWindow, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 500 + dx,
      clientY: 102,
      isPrimary: true,
    });
    fireEvent.pointerUp(pageWindow, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 500 + dx,
      clientY: 102,
      isPrimary: true,
    });
    return { captureCalls };
  }

  it("advances a page on a touch swipe without taking pointer capture", () => {
    render(
      <Launcher
        entries={PAGE2}
        pageGroups={PAGE2_GROUPS}
        onLaunch={() => {}}
      />,
    );
    let result: { captureCalls: number } = { captureCalls: -1 };
    act(() => {
      result = touchSwipeWithCaptureCancel(-300);
    });
    // The fix must not capture touch pointers (so the WebView never cancels) …
    expect(result.captureCalls).toBe(0);
    // … and the flick therefore commits to the next page.
    expect(actions()).toContain("page-swipe");
  });
});

describe("Launcher interaction telemetry", () => {
  it("emits launch on tap", () => {
    const onLaunch = vi.fn();
    render(
      <Launcher
        entries={[entry("chat", "Chat")]}
        pageGroups={[["chat"]]}
        onLaunch={onLaunch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    const launch = readViewInteractions().find((e) => e.action === "launch");
    expect(launch?.viewId).toBe("chat");
  });
});
