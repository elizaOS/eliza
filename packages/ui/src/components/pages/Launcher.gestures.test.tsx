// @vitest-environment jsdom
//
// SCOPE (honest labelling, #10722): this is the Launcher's BRIDGE-LOGIC unit
// suite — it verifies what the Launcher DOES with a gesture result (the
// Reorder.Group `onReorder` → moveIcon → persist + telemetry bridge, and the
// swipe-paging `onDragEnd` → page-advance + threshold/clamp/edit-gate bridge).
// motion/react is mocked so those callbacks can be invoked directly; jsdom
// cannot perform a real pointer drag, so this does NOT prove the drag/reorder
// physics or long-press engagement. The REAL long-press-drag reorder (a genuine
// CDP pointer drag → onReorder → persisted LAUNCHER_STORAGE_KEY order + reorder
// telemetry + no duplicate ids) is covered by the isolated-browser runner
// run-launcher-reorder-e2e.mjs. The real-motion render path (page dots,
// favorites, image tiles) is covered by the sibling Launcher.test.tsx.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewEntry } from "../../hooks/view-catalog";
import { LAUNCHER_STORAGE_KEY } from "../../state/launcher-layout";
import {
  readViewInteractions,
  type ViewInteractionAction,
} from "../../view-telemetry";

// Captures the latest gesture callbacks the Launcher hands to motion/react.
const bus = vi.hoisted(() => ({
  onDragEnd: null as
    | null
    | ((e: unknown, info: { offset: { x: number; y: number } }) => void),
  onReorder: null as null | ((next: string[]) => void),
  values: [] as string[],
}));

vi.mock("motion/react", () => ({
  // Any motion.* element renders its children and records onDragEnd.
  motion: new Proxy(
    {},
    {
      get: () => (props: { children?: ReactNode; onDragEnd?: unknown }) => {
        if (props.onDragEnd) {
          bus.onDragEnd = props.onDragEnd as typeof bus.onDragEnd;
        }
        return props.children ?? null;
      },
    },
  ),
  Reorder: {
    Group: (props: {
      children?: ReactNode;
      onReorder?: (next: string[]) => void;
      values?: string[];
    }) => {
      bus.onReorder = props.onReorder ?? null;
      bus.values = props.values ?? [];
      return props.children ?? null;
    },
    Item: (props: { children?: ReactNode }) => props.children ?? null,
  },
}));

// Import AFTER the mock is registered.
import { Launcher } from "./Launcher";

const originalMatchMedia = window.matchMedia;

/**
 * Edit mode is entered via a long-press on a tile (the visible Edit button was
 * removed per product). Self-contained fake-timer window so non-timer tests stay
 * on real timers.
 */
function longPressTile(label: string): void {
  vi.useFakeTimers();
  const tile = screen.getByRole("button", { name: label });
  fireEvent.pointerDown(tile);
  act(() => {
    vi.advanceTimersByTime(450);
  });
  fireEvent.pointerUp(tile);
  vi.useRealTimers();
}

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

const PAGE2 = Array.from({ length: 25 }, (_, i) => entry(`v${i}`, `View ${i}`));

beforeEach(() => {
  mockDesktopPagingMedia({ finePointer: false });
  window.localStorage.clear();
  clearTelemetry();
  bus.onDragEnd = null;
  bus.onReorder = null;
  bus.values = [];
});
afterEach(() => {
  cleanup();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

describe("Launcher drag-reorder bridge", () => {
  it("persists a reordered page through moveIcon and emits a reorder event", () => {
    render(<Launcher entries={PAGE2} onLaunch={() => {}} />);
    longPressTile("View 0");
    // Page 0 holds the first 20 ids; move the first to the end.
    expect(bus.values.slice(0, 3)).toEqual(["v0", "v1", "v2"]);
    const reordered = [...bus.values.slice(1), bus.values[0]];
    act(() => {
      bus.onReorder?.(reordered);
    });

    const stored = JSON.parse(
      window.localStorage.getItem(LAUNCHER_STORAGE_KEY) ?? "{}",
    );
    expect(stored.manual).toBe(true);
    expect(stored.pages[0][0]).toBe("v1");
    expect(stored.pages[0]).not.toContain(undefined);
    // No duplicates introduced by the repack.
    const flat = stored.pages.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(actions()).toContain("reorder");
  }, 15_000);
});

describe("Launcher swipe paging (onDragEnd)", () => {
  it("advances a page past the swipe threshold and emits page-swipe", () => {
    render(<Launcher entries={PAGE2} onLaunch={() => {}} />);
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
    render(<Launcher entries={PAGE2} onLaunch={() => {}} />);
    act(() => {
      horizontalSwipe(-30);
    });
    expect(
      screen.getByTestId("launcher-page-1").getAttribute("aria-hidden"),
    ).toBe("true");
    expect(actions()).not.toContain("page-swipe");
  });

  it("clamps at the first page (no underflow)", () => {
    render(<Launcher entries={PAGE2} onLaunch={() => {}} />);
    // Already on page 0; a rightward swipe would go to -1 → clamped, no event.
    act(() => {
      horizontalSwipe(300);
    });
    expect(actions()).not.toContain("page-swipe");
  });

  it("does not page while in edit mode", () => {
    render(<Launcher entries={PAGE2} onLaunch={() => {}} />);
    longPressTile("View 0");
    act(() => {
      horizontalSwipe(-300);
    });
    expect(
      screen.getByTestId("launcher-page-1").getAttribute("aria-hidden"),
    ).toBe("true");
    expect(actions()).not.toContain("page-swipe");
  });

  it("hides pager edge buttons when the pointer is coarse", () => {
    mockDesktopPagingMedia({ finePointer: false });
    render(<Launcher entries={PAGE2} onLaunch={() => {}} />);

    expect(screen.queryByTestId("launcher-pager-edge-prev")).toBeNull();
    expect(screen.queryByTestId("launcher-pager-edge-next")).toBeNull();
  });

  it("shows pager edge buttons on any fine-pointer window — the gate has no min-width clause", () => {
    mockDesktopPagingMedia({ finePointer: true });
    render(<Launcher entries={PAGE2} onLaunch={() => {}} />);

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
    render(<Launcher entries={PAGE2} onLaunch={() => {}} />);

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
    render(<Launcher entries={PAGE2} onLaunch={() => {}} />);
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
    render(<Launcher entries={[entry("chat", "Chat")]} onLaunch={onLaunch} />);
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    const launch = readViewInteractions().find((e) => e.action === "launch");
    expect(launch?.viewId).toBe("chat");
  });

  it("emits favorite then unfavorite as metadata is toggled", () => {
    render(
      <Launcher entries={[entry("notes", "Notes")]} onLaunch={() => {}} />,
    );
    longPressTile("Notes");
    fireEvent.click(screen.getByTestId("launcher-fav-notes"));
    fireEvent.click(screen.getByTestId("launcher-fav-notes"));
    expect(actions()).toContain("favorite");
    expect(actions()).toContain("unfavorite");
  });

  it("emits edit-mode enter/exit via long-press toggle", () => {
    render(<Launcher entries={[entry("chat", "Chat")]} onLaunch={() => {}} />);
    // First long-press enters edit mode, the second exits it.
    longPressTile("Chat");
    longPressTile("Chat");
    expect(actions()).toContain("edit-mode-enter");
    expect(actions()).toContain("edit-mode-exit");
  });
});
