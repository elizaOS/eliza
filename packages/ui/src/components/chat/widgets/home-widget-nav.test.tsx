// @vitest-environment jsdom
//
// Behavioral coverage for `useWidgetNavigation` + `HomeWidgetCard` as the ONE
// shared renderer every home-priority per-plugin card (calendar / finances /
// health / goals / …) routes taps through. The per-widget tests
// (calendar-upcoming / finances-alerts / health-sleep) assert the CustomEvent
// rail fires, but NONE of them assert the second half of the nav contract —
// that `openView` ALSO reports the switch to the proactive decider via
// `reportUserViewSwitch(viewId, path)` — nor double-tap idempotency, the
// viewId-fallback edge, or the hook's documented memoization stability.
//
// This drives the real hook (only its collaborators — the slash-command
// controller's `reportUserViewSwitch` and the app-store `setTab` — are mocked)
// with per-plugin fixtures, so one file covers the shared navigation seam once.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Wallet } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportUserViewSwitchSpy, setTabSpy } = vi.hoisted(() => ({
  reportUserViewSwitchSpy: vi.fn(),
  setTabSpy: vi.fn(),
}));

// The proactive-decider report rail — assert its exact (viewId, path) payload.
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: reportUserViewSwitchSpy,
}));

// HomeWidgetCard's nav hook reads `setTab` off the app store; feed a stable spy
// so `openTab` is observable and the hook's `[setTab]` memo dep stays constant.
vi.mock("../../../state", () => ({
  useAppSelectorShallow: (selector: (s: { setTab: unknown }) => unknown) =>
    selector({ setTab: setTabSpy }),
}));

import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

/** Capture every `eliza:navigate:view` viewPath dispatched during `fn`. */
function captureNav(fn: () => void): string[] {
  const paths: string[] = [];
  const onNav = (e: Event) => {
    const detail = (e as CustomEvent<{ viewPath?: string }>).detail;
    if (detail?.viewPath) paths.push(detail.viewPath);
  };
  window.addEventListener("eliza:navigate:view", onNav);
  try {
    fn();
  } finally {
    window.removeEventListener("eliza:navigate:view", onNav);
  }
  return paths;
}

/**
 * Per-plugin home-card fixtures: each is the SAME HomeWidgetCard renderer wired
 * to the real nav hook, differing only by the (path, viewId, tone, datum) the
 * owning widget passes. `openView(path, viewId)` is the exact call each widget
 * makes in its `onActivate` (see calendar-upcoming / finances-alerts /
 * health-sleep .tsx).
 */
const FIXTURES = [
  {
    plugin: "calendar",
    path: "/calendar",
    viewId: "calendar",
    tone: "default" as const,
    value: "Standup",
  },
  {
    plugin: "finances",
    path: "/finances",
    viewId: "finances",
    tone: "danger" as const,
    value: "-$42.50",
  },
  {
    plugin: "health",
    path: "/health",
    viewId: "health",
    tone: "default" as const,
    value: "7h 45m",
  },
];

/** A card that navigates exactly the way a home widget's onActivate does. */
function NavCard({
  path,
  viewId,
  tone,
  value,
  testId,
}: {
  path: string;
  viewId: string;
  tone: "default" | "danger" | "warn";
  value: string;
  testId: string;
}) {
  const nav = useWidgetNavigation();
  return (
    <HomeWidgetCard
      icon={<Wallet />}
      label={testId}
      value={value}
      tone={tone}
      testId={testId}
      ariaLabel={`${testId} ${value}. Open view.`}
      onActivate={() => nav.openView(path, viewId)}
    />
  );
}

afterEach(cleanup);
beforeEach(() => {
  reportUserViewSwitchSpy.mockReset();
  setTabSpy.mockReset();
});

describe("home-widget navigation (shared renderer, per-plugin fixtures)", () => {
  for (const fx of FIXTURES) {
    it(`${fx.plugin}: tapping fires BOTH nav rails — CustomEvent(${fx.path}) + reportUserViewSwitch("${fx.viewId}", "${fx.path}")`, () => {
      const testId = `wc-${fx.plugin}`;
      render(
        <NavCard
          path={fx.path}
          viewId={fx.viewId}
          tone={fx.tone}
          value={fx.value}
          testId={testId}
        />,
      );

      const card = screen.getByTestId(testId);
      // The high-priority datum is on the card (renders the datum).
      expect(card.textContent).toContain(fx.value);

      const navPaths = captureNav(() => fireEvent.click(card));

      // Rail 1: the view-navigation CustomEvent carries the exact viewPath.
      expect(navPaths).toEqual([fx.path]);
      // Rail 2: the proactive-decider report gets (viewId, path) — the half the
      // per-widget tests never assert. A regression that drops the viewId (e.g.
      // reportUserViewSwitch(path) or forgetting the call) fails here.
      expect(reportUserViewSwitchSpy).toHaveBeenCalledTimes(1);
      expect(reportUserViewSwitchSpy).toHaveBeenCalledWith(fx.viewId, fx.path);
    });
  }

  it("renders the danger tone on the alert value (finances overdrawn datum)", () => {
    render(
      <NavCard
        path="/finances"
        viewId="finances"
        tone="danger"
        value="-$42.50"
        testId="wc-finances-tone"
      />,
    );
    // The overdrawn balance is an alert value — its tone reaches the DOM as the
    // danger text class (not the default white), end-to-end through the card.
    const valueEl = screen.getByText("-$42.50");
    expect(valueEl.className).toMatch(/text-danger/);
    expect(valueEl.className).not.toMatch(/text-white/);
  });

  it("double-tap is idempotent to the SAME view — both taps route to /finances (no corruption)", () => {
    render(
      <NavCard
        path="/finances"
        viewId="finances"
        tone="danger"
        value="-$42.50"
        testId="wc-dbl"
      />,
    );
    const card = screen.getByTestId("wc-dbl");
    const navPaths = captureNav(() => {
      fireEvent.click(card);
      fireEvent.click(card);
    });

    // A rapid double-tap must deterministically hit the same view twice with an
    // identical payload — never a drifted path or a viewId lost on the 2nd tap.
    expect(navPaths).toEqual(["/finances", "/finances"]);
    expect(reportUserViewSwitchSpy).toHaveBeenCalledTimes(2);
    expect(reportUserViewSwitchSpy).toHaveBeenNthCalledWith(
      1,
      "finances",
      "/finances",
    );
    expect(reportUserViewSwitchSpy).toHaveBeenNthCalledWith(
      2,
      "finances",
      "/finances",
    );
  });

  it("falls back to the path as the viewId when a widget omits it (openView with no viewId)", () => {
    function BareNavCard() {
      const nav = useWidgetNavigation();
      return (
        <HomeWidgetCard
          icon={<Wallet />}
          label="bare"
          value="x"
          testId="wc-bare"
          ariaLabel="bare"
          onActivate={() => nav.openView("/goals")}
        />
      );
    }
    render(<BareNavCard />);
    const navPaths = captureNav(() =>
      fireEvent.click(screen.getByTestId("wc-bare")),
    );
    expect(navPaths).toEqual(["/goals"]);
    // viewId defaults to the path so the decider still gets a stable id.
    expect(reportUserViewSwitchSpy).toHaveBeenCalledWith("/goals", "/goals");
  });

  it("openTab switches the builtin tab AND reports the switch (no viewPath CustomEvent)", () => {
    function TabCard() {
      const nav = useWidgetNavigation();
      return (
        <HomeWidgetCard
          icon={<Wallet />}
          label="tab"
          value="x"
          testId="wc-tab"
          ariaLabel="tab"
          onActivate={() => nav.openTab("chat")}
        />
      );
    }
    render(<TabCard />);
    const navPaths = captureNav(() =>
      fireEvent.click(screen.getByTestId("wc-tab")),
    );
    // Tab switches go through setTab, not the view-path rail.
    expect(navPaths).toEqual([]);
    expect(setTabSpy).toHaveBeenCalledWith("chat");
    expect(reportUserViewSwitchSpy).toHaveBeenCalledWith("chat");
  });

  it("returns a STABLE nav object across re-renders (never breaks widget memoization)", () => {
    const seen: ReturnType<typeof useWidgetNavigation>[] = [];
    function Probe() {
      seen.push(useWidgetNavigation());
      return null;
    }
    const { rerender } = render(<Probe />);
    act(() => {
      rerender(<Probe />);
      rerender(<Probe />);
    });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    // The hook memoizes on `[setTab]`; a stable store means one identity across
    // renders, so a memoized widget consuming it never re-renders on nav.
    for (const nav of seen) {
      expect(nav).toBe(seen[0]);
    }
  });
});
