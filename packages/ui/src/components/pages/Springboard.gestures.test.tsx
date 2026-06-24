// @vitest-environment jsdom
//
// Gesture-layer + telemetry coverage for the Springboard. motion/react is mocked
// so the test can drive the Reorder.Group onReorder bridge and the swipe-paging
// motion.div onDragEnd directly (jsdom can't perform a real pointer drag). The
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

// Captures the latest gesture callbacks the Springboard hands to motion/react.
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
      get:
        () => (props: { children?: ReactNode; onDragEnd?: unknown }) => {
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
import { Springboard } from "./Springboard";

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
  bus.onDragEnd = null;
  bus.onReorder = null;
  bus.values = [];
});
afterEach(() => cleanup());

describe("Springboard drag-reorder bridge", () => {
  it("persists a reordered page through moveIcon and emits a reorder event", () => {
    render(<Springboard entries={PAGE2} onLaunch={() => {}} />);
    // Page 0 holds the first 20 ids; move the first to the end.
    expect(bus.values.slice(0, 3)).toEqual(["v0", "v1", "v2"]);
    const reordered = [...bus.values.slice(1), bus.values[0]];
    act(() => {
      bus.onReorder?.(reordered);
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

describe("Springboard swipe paging (onDragEnd)", () => {
  it("advances a page past the swipe threshold and emits page-swipe", () => {
    render(<Springboard entries={PAGE2} onLaunch={() => {}} />);
    expect(screen.queryByTestId("springboard-tile-v20")).toBeNull();
    act(() => {
      bus.onDragEnd?.({}, { offset: { x: -70, y: 0 } });
    });
    // Page 1 now shows v20..v24.
    expect(screen.getByTestId("springboard-tile-v20")).toBeTruthy();
    expect(actions()).toContain("page-swipe");
  });

  it("ignores a drag below the threshold", () => {
    render(<Springboard entries={PAGE2} onLaunch={() => {}} />);
    act(() => {
      bus.onDragEnd?.({}, { offset: { x: -30, y: 0 } });
    });
    expect(screen.queryByTestId("springboard-tile-v20")).toBeNull();
    expect(actions()).not.toContain("page-swipe");
  });

  it("clamps at the first page (no underflow)", () => {
    render(<Springboard entries={PAGE2} onLaunch={() => {}} />);
    // Already on page 0; a rightward swipe would go to -1 → clamped, no event.
    act(() => {
      bus.onDragEnd?.({}, { offset: { x: 80, y: 0 } });
    });
    expect(actions()).not.toContain("page-swipe");
  });

  it("does not page while in edit mode", () => {
    render(<Springboard entries={PAGE2} onLaunch={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    act(() => {
      bus.onDragEnd?.({}, { offset: { x: -80, y: 0 } });
    });
    expect(screen.queryByTestId("springboard-tile-v20")).toBeNull();
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

  it("emits favorite then unfavorite as the dock is toggled", () => {
    render(
      <Springboard entries={[entry("notes", "Notes")]} onLaunch={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByTestId("springboard-fav-notes"));
    fireEvent.click(screen.getByTestId("springboard-fav-notes"));
    expect(actions()).toContain("favorite");
    expect(actions()).toContain("unfavorite");
  });

  it("emits edit-mode enter/exit on the toggle", () => {
    render(
      <Springboard entries={[entry("chat", "Chat")]} onLaunch={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(actions()).toContain("edit-mode-enter");
    expect(actions()).toContain("edit-mode-exit");
  });
});
