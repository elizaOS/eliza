// @vitest-environment jsdom
//
// Gesture-layer + telemetry coverage for the Springboard. motion/react is mocked
// so the test can drive the Reorder.Group onReorder bridge directly and so the
// page track renders as a plain div (jsdom can't run a real spring). Swipe paging
// is exercised through the real pointer handlers on the carousel viewport. The
// real-motion render path (page dots, favorites, image tiles) is covered by the
// sibling Springboard.test.tsx, which does NOT mock motion.

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
import { SPRINGBOARD_STORAGE_KEY } from "../../state/springboard-layout";
import {
  readViewInteractions,
  type ViewInteractionAction,
} from "../../view-telemetry";

// Captures the Reorder bridge for every page group the Springboard renders. The
// carousel mounts one Reorder.Group per page (all pages stay mounted), so the
// bus keeps them keyed by the page's first view id — tests target the page they
// mean. Each render re-registers (overwrites) its page, so the latest callback
// always wins.
const bus = vi.hoisted(() => ({
  groups: new Map<
    string,
    { onReorder: ((next: string[]) => void) | null; values: string[] }
  >(),
  /** The group whose page starts with `firstId` (e.g. "v0" = page 0). */
  group(firstId: string) {
    const found = this.groups.get(firstId);
    if (!found) throw new Error(`No Reorder group starting with ${firstId}`);
    return found;
  },
}));

vi.mock("motion/react", () => ({
  // Any motion.* element renders its children as a plain div, preserving the
  // dom-affecting props (className / data-testid / style) the carousel relies on.
  motion: new Proxy(
    {},
    {
      get:
        () =>
        ({
          children,
          // `x` lives on the motion `style` and isn't a valid DOM style key, so
          // strip it; everything else (className, data-testid, aria-*) passes
          // through onto a real div the tests can query.
          style: _style,
          ...rest
        }: {
          children?: ReactNode;
          style?: unknown;
          [key: string]: unknown;
        }) => (
          // biome-ignore lint/suspicious/noExplicitAny: forwarding arbitrary motion props to a plain div in tests.
          <div {...(rest as any)}>{children}</div>
        ),
    },
  ),
  // A motion value is just a mutable get/set holder in the mock.
  useMotionValue: (initial: number) => {
    let current = initial;
    return {
      get: () => current,
      set: (next: number) => {
        current = next;
      },
    };
  },
  // animate() resolves synchronously in the mock (no spring); return a stoppable.
  animate: () => ({ stop: () => {} }),
  Reorder: {
    Group: (props: {
      children?: ReactNode;
      onReorder?: (next: string[]) => void;
      values?: string[];
    }) => {
      const values = props.values ?? [];
      const key = values[0] ?? "empty";
      bus.groups.set(key, { onReorder: props.onReorder ?? null, values });
      return props.children ?? null;
    },
    Item: (props: { children?: ReactNode }) => props.children ?? null,
  },
}));

// Import AFTER the mock is registered.
import { Springboard } from "./Springboard";

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

function actions(): ViewInteractionAction[] {
  return readViewInteractions().map((e) => e.action);
}

const PAGE2 = Array.from({ length: 25 }, (_, i) => entry(`v${i}`, `View ${i}`));

beforeEach(() => {
  window.localStorage.clear();
  clearTelemetry();
  bus.groups.clear();
});
afterEach(() => cleanup());

/** Whether a page element is the visible (committed) one. */
function pageVisible(index: number): boolean {
  return (
    screen
      .getByTestId(`springboard-page-${index}`)
      .getAttribute("aria-hidden") === "false"
  );
}

/**
 * Drive a real horizontal carousel drag on the viewport: down, a series of
 * moves so the axis lock decides "x", then up. dx is the net horizontal travel;
 * dy stays 0 so the move locks horizontal. jsdom reports a 0-width viewport, so
 * the live translate can't be asserted, but the axis-lock + commit-threshold
 * logic (which is what these tests cover) runs on the raw deltas.
 */
function swipe(dx: number, dy = 0): void {
  const viewport = screen.getByTestId("springboard-pager-viewport");
  fireEvent.pointerDown(viewport, {
    isPrimary: true,
    pointerId: 1,
    clientX: 200,
    clientY: 300,
  });
  // First move past the slop to lock the axis — keep the dx:dy RATIO of the full
  // gesture so the axis lock decides on the real direction. Then the final pos.
  const mag = Math.hypot(dx, dy) || 1;
  const scale = 16 / mag;
  fireEvent.pointerMove(viewport, {
    pointerId: 1,
    clientX: 200 + dx * scale,
    clientY: 300 + dy * scale,
  });
  fireEvent.pointerMove(viewport, {
    pointerId: 1,
    clientX: 200 + dx,
    clientY: 300 + dy,
  });
  fireEvent.pointerUp(viewport, {
    pointerId: 1,
    clientX: 200 + dx,
    clientY: 300 + dy,
  });
}

describe("Springboard drag-reorder bridge", () => {
  it("persists a reordered page through moveIcon and emits a reorder event", () => {
    render(<Springboard entries={PAGE2} onLaunch={() => {}} />);
    // Page 0 holds the first 24 ids; move the first to the end of page 0.
    const page0 = bus.group("v0");
    expect(page0.values.slice(0, 3)).toEqual(["v0", "v1", "v2"]);
    const reordered = [...page0.values.slice(1), page0.values[0]];
    act(() => {
      page0.onReorder?.(reordered);
    });

    const stored = JSON.parse(
      window.localStorage.getItem(SPRINGBOARD_STORAGE_KEY) ?? "{}",
    );
    expect(stored.manual).toBe(true);
    expect(stored.pages[0][0]).toBe("v1");
    expect(stored.pages[0]).not.toContain(undefined);
    // No duplicates introduced by the repack.
    const flat = stored.pages.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(actions()).toContain("reorder");
  });
});

describe("Springboard carousel paging (pointer drag)", () => {
  it("advances a page past the swipe threshold and emits page-swipe", () => {
    render(<Springboard entries={PAGE2} onLaunch={() => {}} />);
    // Page 0 is committed at first.
    expect(pageVisible(0)).toBe(true);
    expect(pageVisible(1)).toBe(false);
    act(() => {
      swipe(-70);
    });
    // The track settles to page 1 — the second page becomes visible.
    expect(pageVisible(1)).toBe(true);
    expect(pageVisible(0)).toBe(false);
    expect(actions()).toContain("page-swipe");
  });

  it("ignores a horizontal drag below the threshold", () => {
    render(<Springboard entries={PAGE2} onLaunch={() => {}} />);
    act(() => {
      swipe(-30);
    });
    expect(pageVisible(0)).toBe(true);
    expect(actions()).not.toContain("page-swipe");
  });

  it("clamps at the first page (no underflow)", () => {
    render(<Springboard entries={PAGE2} onLaunch={() => {}} />);
    // Already on page 0; a rightward swipe would go to -1 → clamped, no event.
    act(() => {
      swipe(80);
    });
    expect(pageVisible(0)).toBe(true);
    expect(actions()).not.toContain("page-swipe");
  });

  it("does not commit a page on a vertical drag (axis lock yields to scroll)", () => {
    render(<Springboard entries={PAGE2} onLaunch={() => {}} />);
    // A mostly-vertical gesture locks to the y axis and never pages.
    act(() => {
      swipe(20, 120);
    });
    expect(pageVisible(0)).toBe(true);
    expect(actions()).not.toContain("page-swipe");
  });

  it("does not page while in edit mode", () => {
    render(<Springboard entries={PAGE2} onLaunch={() => {}} />);
    longPressTile("View 0");
    act(() => {
      swipe(-80);
    });
    expect(pageVisible(0)).toBe(true);
    expect(actions()).not.toContain("page-swipe");
  });
});

describe("Springboard interaction telemetry", () => {
  it("emits launch on tap", () => {
    const onLaunch = vi.fn();
    render(
      <Springboard entries={[entry("chat", "Chat")]} onLaunch={onLaunch} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    const launch = readViewInteractions().find((e) => e.action === "launch");
    expect(launch?.viewId).toBe("chat");
  });

  it("emits edit-mode enter/exit via long-press toggle", () => {
    render(
      <Springboard entries={[entry("chat", "Chat")]} onLaunch={() => {}} />,
    );
    // First long-press enters edit mode, the second exits it.
    longPressTile("Chat");
    longPressTile("Chat");
    expect(actions()).toContain("edit-mode-enter");
    expect(actions()).toContain("edit-mode-exit");
  });
});
