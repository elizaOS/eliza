// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetHomeDismissalsForTests,
  dismissHomeWidget,
} from "./home-dismissal-store";
import { homeWidgetKey } from "./home-priority";
import { resolveWidgetsForSlot } from "./registry";
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
  resolveWidgetsForSlot: vi.fn((slot: string) =>
    (slot === "home" ? HOME_DECLS : []).map((declaration) => ({
      declaration,
      Component: null,
    })),
  ),
  subscribeWidgetRegistry: () => () => {},
  getWidgetRegistryVersion: () => 0,
}));

beforeEach(() => {
  vi.mocked(resolveWidgetsForSlot).mockImplementation((slot: string) =>
    (slot === "home" ? HOME_DECLS : []).map((declaration) => ({
      declaration,
      Component: null,
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  __resetHomeDismissalsForTests();
});

function renderedIds(): string[] {
  return screen
    .getAllByTestId(/^widget-uispec-/)
    .map((el) => el.getAttribute("data-testid")?.replace("widget-uispec-", ""))
    .filter((id): id is string => Boolean(id));
}

describe("WidgetHost home-slot ranking (#9143)", () => {
  it("renders every home widget, ranked by score (lower order first)", () => {
    render(<WidgetHost slot="home" />);

    const ids = renderedIds();
    // The home surface renders all declared widgets ranked by importance — each
    // widget self-hides when empty, so the cap is only a safety bound. These
    // uiSpec widgets always render, so all 10 appear in base-order.
    expect(ids).toEqual([
      "w0",
      "w1",
      "w2",
      "w3",
      "w4",
      "w5",
      "w6",
      "w7",
      "w8",
      "w9",
    ]);
  });

  it("is deterministic — the ranked order is stable across re-renders", () => {
    const { rerender } = render(<WidgetHost slot="home" />);
    const first = renderedIds();

    rerender(<WidgetHost slot="home" className="changed" />);
    const second = renderedIds();

    expect(second).toEqual(first);
    expect(first[0]).toBe("w0");
  });

  it("a live high-weight activity event floats a subscribing low-base widget to the top", () => {
    // w9 has the worst base (order 90), so it normally ranks last. Subscribe it
    // to `blocked` and feed a fresh blocked event: its attention boost
    // (weight 10) outranks every quiet widget's base (≤1) → it sorts first.
    const subscribed = HOME_DECLS.map((d) =>
      d.id === "w9" ? { ...d, signalKinds: ["blocked"] as const } : d,
    );
    vi.mocked(resolveWidgetsForSlot).mockImplementation((slot: string) =>
      (slot === "home" ? subscribed : []).map((declaration) => ({
        declaration,
        Component: null,
      })),
    );

    render(
      <WidgetHost
        slot="home"
        events={[
          {
            id: "e1",
            eventType: "blocked",
            timestamp: Date.now(),
            summary: "Run blocked",
          },
        ]}
      />,
    );

    const ids = renderedIds();
    expect(ids).toContain("w9");
    expect(ids[0]).toBe("w9");
  });

  it("does not render default-sink participant declarations as duplicate cards", () => {
    const participant: PluginWidgetDeclaration = {
      id: "plugin.default-home",
      pluginId: "plugin",
      slot: "home",
      label: "Plugin",
      defaultWidget: "activity",
      uiSpec: {
        root: "root",
        state: {},
        elements: {
          root: {
            type: "Text",
            props: { text: "participant should not render" },
            children: [],
          },
        },
      },
    };
    vi.mocked(resolveWidgetsForSlot).mockImplementation((slot: string) =>
      slot === "home"
        ? [
            ...HOME_DECLS.map((declaration) => ({
              declaration,
              Component: null,
            })),
            {
              declaration: participant,
              Component: null,
              defaultWidgetSink: "activity" as const,
            },
          ]
        : [],
    );

    render(<WidgetHost slot="home" />);

    expect(screen.queryByText("participant should not render")).toBeNull();
  });

  // #9959 — the show-once-then-sunset lifecycle: a home widget declaring a
  // `sunset` policy must be dropped from the ranked home set once its condition
  // is met (here: a dismissible card the user dismissed), while non-sunset
  // widgets stay. This is the WidgetHost-level filter, complementing the
  // pure-`isHomeWidgetSunset` unit tests in home-dismissal-store.test.ts.
  it("filters a sunset-retired widget out of the home grid (#9959)", () => {
    const ftu: PluginWidgetDeclaration = {
      ...homeDecl("ftu-welcome", 0), // best base order → would otherwise rank first
      sunset: { dismissible: true },
    };
    const declsFor = (slot: string) =>
      (slot === "home" ? [ftu, homeDecl("keep", 10)] : []).map(
        (declaration) => ({ declaration, Component: null }),
      );
    vi.mocked(resolveWidgetsForSlot).mockImplementation(declsFor);

    // Before dismissal the sunset card renders (and, with order 0, ranks first).
    const before = render(<WidgetHost slot="home" />);
    expect(renderedIds()).toContain("ftu-welcome");
    before.unmount();

    // After the user dismisses it, WidgetHost retires it from the home grid…
    dismissHomeWidget(
      homeWidgetKey({ id: "ftu-welcome", pluginId: "home-plugin" }),
    );
    render(<WidgetHost slot="home" />);
    const ids = renderedIds();
    expect(ids).not.toContain("ftu-welcome");
    // …while the non-sunset widget is unaffected.
    expect(ids).toContain("keep");
  });
});
