// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginWidgetDeclaration } from "./types";
import { WidgetHost } from "./WidgetHost";

// #9143 — the home slot must rank its declared widgets and render only the
// top-N (HOME_MAX_VISIBLE = 6). Other slots render everything unchanged.

const mockAppState = {
  plugins: [{ id: "home-plugin", enabled: true, isActive: true }],
  t: (key: string) => key,
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

/** A minimal uiSpec home widget keyed by id + base `order`. */
function homeDecl(id: string, order: number): PluginWidgetDeclaration {
  return {
    id,
    pluginId: "home-plugin",
    slot: "home",
    label: id,
    order,
    uiSpec: {
      root: "root",
      state: {},
      elements: {
        root: { type: "Text", props: { text: id }, children: [] },
      },
    },
  };
}

// Ten home widgets with distinct base orders. Lower order = higher base score,
// so the deterministic ranking surfaces w0..w5 (orders 0..50) and drops the
// four with the highest orders. Declared out of order to prove the host ranks
// rather than relying on resolver order.
const HOME_DECLS = [
  homeDecl("w7", 70),
  homeDecl("w2", 20),
  homeDecl("w9", 90),
  homeDecl("w0", 0),
  homeDecl("w5", 50),
  homeDecl("w3", 30),
  homeDecl("w8", 80),
  homeDecl("w1", 10),
  homeDecl("w6", 60),
  homeDecl("w4", 40),
];

vi.mock("./registry", () => ({
  resolveWidgetsForSlot: (slot: string) =>
    (slot === "home" ? HOME_DECLS : []).map((declaration) => ({
      declaration,
      Component: null,
    })),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderedIds(): string[] {
  return screen
    .getAllByTestId(/^widget-uispec-/)
    .map((el) => el.getAttribute("data-testid")?.replace("widget-uispec-", ""))
    .filter((id): id is string => Boolean(id));
}

describe("WidgetHost home-slot ranking (#9143)", () => {
  it("renders only the top-6 home widgets, ranked by score (lower order first)", () => {
    render(<WidgetHost slot="home" />);

    const ids = renderedIds();
    expect(ids).toHaveLength(6);
    // Lower `order` → higher base score → rendered first; top-6 are w0..w5.
    expect(ids).toEqual(["w0", "w1", "w2", "w3", "w4", "w5"]);

    // The four lowest-priority widgets are dropped.
    for (const dropped of ["w6", "w7", "w8", "w9"]) {
      expect(screen.queryByTestId(`widget-uispec-${dropped}`)).toBeNull();
    }
  });

  it("is deterministic — the ranked order is stable across re-renders", () => {
    const { rerender } = render(<WidgetHost slot="home" />);
    const first = renderedIds();

    rerender(<WidgetHost slot="home" className="changed" />);
    const second = renderedIds();

    expect(second).toEqual(first);
    expect(first).toEqual(["w0", "w1", "w2", "w3", "w4", "w5"]);
  });
});
