// @vitest-environment jsdom

/**
 * Render-storm lock (#9304).
 *
 * `WidgetHost` (home slot) subscribes to `useNow`, which ticks every 60s so the
 * attention-decay math stays live. The bug: the ranked + rendered child set was
 * rebuilt on EVERY tick, so all home widgets re-rendered each minute even when
 * nothing about the ranking changed. This test locks the fix with real React
 * commit counts (`makeRenderCounter` + `useRenderSpy`):
 *
 *  - advancing `now` with unchanged signals must NOT re-render any widget child
 *    (the order is stable ⇒ the rendered set is reference-stable), and
 *  - a signal that actually changes the ranking order MUST re-render (so the
 *    dynamic priority still works — the lock can't pass by freezing the UI).
 *
 * It fails-when-broken: the meta-tested counter increments once per real commit,
 * so re-introducing `now` into the rendered-children dependency makes the
 * "no extra render on tick" assertion go red.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeRenderCounter,
  type RenderCounter,
  useRenderSpy,
} from "../testing/render-counter";
import { resolveWidgetsForSlot } from "./registry";
import type { PluginWidgetDeclaration, WidgetProps } from "./types";
import { WidgetHost } from "./WidgetHost";

// --- mocked app surface -----------------------------------------------------

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

vi.mock("./visibility", () => ({
  loadChatSidebarVisibility: () => ({}),
}));

// The notification inbox + self-attention store are subscribed unconditionally
// by WidgetHost. Keep them empty + reference-stable so they don't perturb the
// ranking (this test drives priority purely through `events`).
vi.mock("../state/notifications/notification-store", () => ({
  useNotifications: () => ({ notifications: [], unreadCount: 0 }),
}));
vi.mock("./home-attention-store", () => ({
  useHomeAttentionSignals: () => [],
}));
// Stable reference — the real hook is backed by a store; returning a fresh
// object each call would itself churn `resolved` (and is not what we're testing).
const STABLE_ENABLED_KINDS = {};
vi.mock("../state/useViewKinds", () => ({
  useEnabledViewKinds: () => STABLE_ENABLED_KINDS,
}));

// --- seeded home widgets ----------------------------------------------------

// A per-widget render counter, keyed by widget id, that the mocked Component
// writes into via useRenderSpy. This is what the lock asserts on.
const counters = new Map<string, RenderCounter>();
function counterFor(id: string): RenderCounter {
  let c = counters.get(id);
  if (!c) {
    c = makeRenderCounter();
    counters.set(id, c);
  }
  return c;
}

// Each declaration gets its own bound Component so the spy records into the
// right per-id counter (the lock asserts on these counts).
function makeSpyComponent(id: string) {
  return function BoundSpy(props: WidgetProps): React.JSX.Element {
    useRenderSpy(counterFor(id));
    return <div data-testid={`spy-${id}`} data-plugin={props.pluginId} />;
  };
}

function homeDecl(id: string, order: number): PluginWidgetDeclaration {
  return {
    id,
    pluginId: "home-plugin",
    slot: "home",
    label: id,
    order,
    // `blocked`-subscribing so a blocked event can boost it.
    signalKinds: ["blocked"],
  };
}

const DECLS = [
  homeDecl("alpha", 10),
  homeDecl("beta", 20),
  homeDecl("gamma", 30),
];

vi.mock("./registry", () => ({
  resolveWidgetsForSlot: vi.fn(),
  subscribeWidgetRegistry: () => () => {},
  getWidgetRegistryVersion: () => 0,
}));

function seedRegistry() {
  vi.mocked(resolveWidgetsForSlot).mockImplementation((slot: string) =>
    (slot === "home" ? DECLS : []).map((declaration) => ({
      declaration,
      Component: makeSpyComponent(declaration.id),
    })),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  counters.clear();
  seedRegistry();
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function totalChildRenders(): number {
  let total = 0;
  for (const c of counters.values()) total += c.count;
  return total;
}

describe("WidgetHost home re-render storm lock (#9304)", () => {
  it("a `now` tick with unchanged signals does NOT re-render any widget child", () => {
    // Stable events array reference across the lifetime of the test.
    const events: never[] = [];
    render(<WidgetHost slot="home" events={events} />);

    // useNow installs the real clock in an effect on mount; flush it.
    act(() => {
      vi.advanceTimersByTime(1);
    });

    const afterMount = new Map(
      Array.from(counters.entries()).map(([id, c]) => [id, c.count]),
    );
    // All three widgets mounted at least once.
    expect(afterMount.size).toBe(3);
    for (const count of afterMount.values()) expect(count).toBeGreaterThan(0);

    const before = totalChildRenders();

    // Advance well past the 60s useNow interval (multiple ticks). The decay math
    // re-runs, `now` changes, but the ranking ORDER is unchanged (no new
    // signals) — so no widget child may re-render.
    act(() => {
      vi.advanceTimersByTime(60_000 * 3 + 100);
    });

    const after = totalChildRenders();
    expect(after).toBe(before); // ZERO extra child renders across 3 ticks
  });

  it("a signal that changes the ranking order DOES re-render the children (priority stays live)", () => {
    const events: {
      id: string;
      eventType: string;
      timestamp: number;
      summary: string;
    }[] = [];
    const { rerender } = render(<WidgetHost slot="home" events={events} />);
    act(() => {
      vi.advanceTimersByTime(1);
    });

    const before = totalChildRenders();

    // Feed a fresh blocked event that boosts `gamma` (worst base order) above
    // alpha/beta — the rendered order changes (gamma → first), so the rendered
    // set is rebuilt and the children re-render. This proves the lock does not
    // pass by freezing the UI.
    const boosted = [
      {
        id: "e1",
        eventType: "blocked",
        timestamp: Date.now(),
        summary: "blocked",
      },
    ];
    // Only gamma subscribes after we narrow signalKinds; simplest: re-seed so
    // only gamma reacts to `blocked`.
    vi.mocked(resolveWidgetsForSlot).mockImplementation((slot: string) =>
      (slot === "home"
        ? DECLS.map((d) =>
            d.id === "gamma"
              ? d
              : {
                  ...d,
                  signalKinds: [] as PluginWidgetDeclaration["signalKinds"],
                },
          )
        : []
      ).map((declaration) => ({
        declaration,
        Component: makeSpyComponent(declaration.id),
      })),
    );

    act(() => {
      rerender(<WidgetHost slot="home" events={boosted} />);
    });

    const after = totalChildRenders();
    expect(after).toBeGreaterThan(before); // order changed ⇒ children re-rendered
  });
});
