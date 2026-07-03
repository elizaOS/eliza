// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeWidgetCard } from "../components/chat/widgets/home-widget-card";
import { __resetHomeDismissalsForTests } from "./home-dismissal-store";
import { resolveWidgetsForSlot } from "./registry";
import type { PluginWidgetDeclaration, WidgetProps } from "./types";
import { WidgetHost } from "./WidgetHost";

// #11752 — home-slot widgets are DIRECT children of the 4-column home grid, so
// each widget's ROOT element (the grid item) must carry the host-provided
// `col-span`. A widget that rendered a bare `HomeWidgetCard` (a `flex w-full`
// button) with no span wrapper fell back to a single auto-placed 1-column
// track; the icon+text then overflowed that narrow track and painted over the
// neighbouring card (finances "Overdrawn" over the goals icon). This locks the
// fix: every home widget wraps its card in `<div className="min-w-0 {span}">`,
// so its grid item spans 2 columns and two widgets share one 4-col row as
// distinct, non-overlapping areas.

const mockAppState = {
  plugins: [{ id: "home-plugin", enabled: true, isActive: true }],
  t: (key: string) => key,
  setTab: vi.fn(),
};

vi.mock("../state", () => ({
  useApp: () => mockAppState,
  useAppSelector: <T,>(selector: (s: typeof mockAppState) => T): T =>
    selector(mockAppState),
  useAppSelectorShallow: <T,>(selector: (s: typeof mockAppState) => T): T =>
    selector(mockAppState),
}));

vi.mock("../state/useDeveloperMode", () => ({
  useIsDeveloperMode: () => false,
}));

// A minimal home widget that reproduces the shipping widgets' root exactly: the
// host-provided span is applied to a wrapper `<div>` (the grid item) and the
// `HomeWidgetCard` button renders inside it — as finances/goals/inbox/… do.
function CardWidget({
  spanClassName = "col-span-2 row-span-1",
  testId,
}: WidgetProps & { testId: string }) {
  return (
    <div className={`min-w-0 ${spanClassName}`} data-testid={`item-${testId}`}>
      <HomeWidgetCard
        icon={<span>i</span>}
        label={testId}
        value="a-very-long-value-that-would-overflow-a-single-column-track"
        testId={testId}
        ariaLabel={testId}
        onActivate={() => {}}
      />
    </div>
  );
}

function cardDecl(id: string, order: number): PluginWidgetDeclaration {
  return {
    id,
    pluginId: "home-plugin",
    slot: "home",
    label: id,
    order,
    // No `size` → default 2×1 home footprint (WidgetHost.spanClassForSize).
  };
}

const CARD_DECLS = [
  cardDecl("finances.alerts", 10),
  cardDecl("goals.attention", 20),
];

vi.mock("./registry", () => ({
  resolveWidgetsForSlot: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(resolveWidgetsForSlot).mockImplementation((slot: string) =>
    (slot === "home" ? CARD_DECLS : []).map((declaration) => ({
      declaration,
      Component: (props: WidgetProps) => (
        <CardWidget {...props} testId={`card-${declaration.id}`} />
      ),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  __resetHomeDismissalsForTests();
});

describe("WidgetHost home-slot grid placement (#11752)", () => {
  it("renders inside a 4-column grid", () => {
    render(<WidgetHost slot="home" />);
    const host = screen.getByTestId("widget-host-home");
    expect(host.className).toContain("grid-cols-4");
  });

  it("WidgetHost threads a 2-col span into each home widget", () => {
    render(<WidgetHost slot="home" />);
    for (const id of ["finances.alerts", "goals.attention"]) {
      const item = screen.getByTestId(`item-card-${id}`);
      // The grid item (widget root) carries the host-supplied 2×1 span…
      expect(item.className).toContain("col-span-2");
      // …never a bare 1-col track (that is the overlap bug)…
      expect(item.className).not.toContain("col-span-1");
      // …and `min-w-0` lets the track constrain the card so its content
      // truncates instead of overflowing into the adjacent cell.
      expect(item.className).toContain("min-w-0");
    }
  });

  it("the card button lives INSIDE its span-carrying grid item", () => {
    render(<WidgetHost slot="home" />);
    for (const id of ["finances.alerts", "goals.attention"]) {
      const item = screen.getByTestId(`item-card-${id}`);
      const button = screen.getByTestId(`card-${id}`);
      // Span is on the grid item, not the button — the button is a descendant.
      expect(item.contains(button)).toBe(true);
      expect(button).not.toBe(item);
      expect(button.className).not.toContain("col-span-1");
    }
  });

  it("two 2-col widgets fill exactly one 4-col row as distinct grid items", () => {
    render(<WidgetHost slot="home" />);
    const host = screen.getByTestId("widget-host-home");
    // Direct grid children only (the widget root wrappers).
    const items = Array.from(host.children) as HTMLElement[];
    expect(items).toHaveLength(2);
    // Distinct DOM nodes, each a 2-col span → 2 + 2 = the 4 available columns,
    // so they flow side by side rather than stacking in the same grid area.
    expect(items[0]).not.toBe(items[1]);
    for (const item of items) {
      expect(item.className).toContain("col-span-2");
    }
  });
});
