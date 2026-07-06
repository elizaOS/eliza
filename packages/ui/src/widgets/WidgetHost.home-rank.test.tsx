// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetHomeDismissalsForTests,
  dismissHomeWidget,
} from "./home-dismissal-store";
import { homeWidgetKey } from "./home-priority";
import { resolveWidgetsForSlot } from "./registry";
import type { PluginWidgetDeclaration } from "./types";
import { WidgetHost } from "./WidgetHost";

// #9143 - the home slot must rank its declared widgets and render only the
// top-N (HOME_RENDER_CAP = 5, spec §E item 2). Other slots render everything
// unchanged.

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
// so the deterministic ranking surfaces the top FIVE (w0..w4, orders 0..40) and
// drops the five with the highest orders (HOME_RENDER_CAP = 5). Declared out of
// order to prove the host ranks rather than relying on resolver order.
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
    .filter((el) => !el.hidden)
    .map((el) => el.getAttribute("data-testid")?.replace("widget-uispec-", ""))
    .filter((id): id is string => Boolean(id));
}

function mountedIds(): string[] {
  return screen
    .getAllByTestId(/^widget-uispec-/)
    .map((el) => el.getAttribute("data-testid")?.replace("widget-uispec-", ""))
    .filter((id): id is string => Boolean(id));
}

function visibleAsyncIds(): string[] {
  return screen
    .getAllByTestId(/^widget-async-/)
    .filter((el) => !el.hidden)
    .map((el) => el.getAttribute("data-testid")?.replace("widget-async-", ""))
    .filter((id): id is string => Boolean(id));
}

describe("WidgetHost home-slot ranking (#9143)", () => {
  it("renders at most HOME_RENDER_CAP (5) home widgets, ranked by score", () => {
    render(<WidgetHost slot="home" />);

    const ids = renderedIds();
    // The home surface ranks all declared widgets by importance and renders only
    // the top five (spec §E item 2: wallpaper + base + notifications + ≤5 cards
    // + chat bar is the whole surface). These uiSpec widgets always render, so
    // the five lowest-order (highest base score) survive the cap in base-order,
    // and the five highest-order are dropped.
    expect(ids).toEqual(["w0", "w1", "w2", "w3", "w4"]);
    expect(ids).not.toContain("w5");
    expect(ids).not.toContain("w9");
    // The lower-ranked declarations still mount so self-hiding/data widgets can
    // fetch and publish attention; WidgetHost caps the actual DOM children after
    // null-rendering widgets disappear.
    expect(mountedIds()).toEqual([
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

  it("is deterministic - the ranked order is stable across re-renders", () => {
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

  it("never renders more than HOME_RENDER_CAP (5) cards under a heavy signal load", () => {
    // Spec §A.4 / §E item 2: the home cap is a HARD ceiling, not just a base-order
    // trim. Subscribe EVERY declared widget to `blocked` and feed a blocked
    // event so all ten want to float to the top at once - the pathological
    // all-active state the cap guards. At most five may render.
    const allSubscribed = HOME_DECLS.map((d) => ({
      ...d,
      signalKinds: ["blocked"] as const,
    }));
    vi.mocked(resolveWidgetsForSlot).mockImplementation((slot: string) =>
      (slot === "home" ? allSubscribed : []).map((declaration) => ({
        declaration,
        Component: null,
      })),
    );

    render(
      <WidgetHost
        slot="home"
        events={[
          {
            id: "e-storm",
            eventType: "blocked",
            timestamp: Date.now(),
            summary: "Everything blocked",
          },
        ]}
      />,
    );

    expect(renderedIds().length).toBeLessThanOrEqual(5);
  });

  it("reapplies the five-card cap when widgets render after async data arrives", async () => {
    function AsyncWidget({ pluginId }: { pluginId: string }) {
      const [visible, setVisible] = useState(false);
      useEffect(() => {
        const timer = setTimeout(() => setVisible(true), 0);
        return () => clearTimeout(timer);
      }, []);
      return visible ? <div data-testid={`widget-async-${pluginId}`} /> : null;
    }

    const declarations = HOME_DECLS.slice(0, 7).map((decl, index) => ({
      ...decl,
      pluginId: `async-${index}`,
      id: `async-${index}`,
    }));
    vi.mocked(resolveWidgetsForSlot).mockImplementation((slot: string) =>
      (slot === "home" ? declarations : []).map((declaration) => ({
        declaration,
        Component: AsyncWidget,
      })),
    );

    render(<WidgetHost slot="home" />);

    await waitFor(() =>
      expect(screen.getAllByTestId(/^widget-async-/)).toHaveLength(7),
    );
    await waitFor(() => expect(visibleAsyncIds()).toHaveLength(5));
  });

  // #9959 - the show-once-then-sunset lifecycle: a home widget declaring a
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
