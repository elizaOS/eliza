// @vitest-environment jsdom
//
// KeepAliveViewHost: rerender-storm detection + sibling-containment + keep-alive
// retention/eviction + pause-stops-timers (#10202 criteria #2/#3/#5 and the
// "one intentional rerender storm" requirement).

import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AnyRenderTelemetryEvent,
  RENDER_TELEMETRY_EVENT,
} from "../../hooks/useRenderGuard";
import {
  __resetResourceCountersForTests,
  snapshotResourceCounters,
} from "../../perf/resource-counters";
import { usePausableInterval } from "../../state/useViewLifecycle";
import {
  __resetViewLifecycleForTests,
  registerViewPolicy,
  viewLifecycleController,
} from "../../state/view-lifecycle";
import {
  VIEW_RUNTIME_TELEMETRY_EVENT,
  type ViewRuntimeTelemetryEvent,
} from "../../view-runtime-telemetry";
import { KeepAliveViewHost } from "./KeepAliveViewHost";

// Render telemetry is gated on test/dev env; vitest sets NODE_ENV=test so
// isRenderTelemetryEnabled() is true.
beforeEach(() => {
  __resetViewLifecycleForTests();
  __resetResourceCountersForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A view that commits `bursts` times in a tight effect loop — a render storm. */
function StormView({ bursts }: { bursts: number }): React.JSX.Element {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n < bursts) setN((v) => v + 1);
  }, [n, bursts]);
  return <div data-testid="storm">{n}</div>;
}

function CalmView(): React.JSX.Element {
  return <div data-testid="calm">calm</div>;
}

/** A view that runs a pausable interval (counts as a pending timer while live). */
function TimerView(): React.JSX.Element {
  usePausableInterval(() => {}, 1000);
  return <div data-testid="timer-view">timer</div>;
}

describe("KeepAliveViewHost — rerender storm", () => {
  it("emits a runtime show sample when a routed view mounts", () => {
    const events: ViewRuntimeTelemetryEvent[] = [];
    const handler = (e: Event) =>
      events.push((e as CustomEvent<ViewRuntimeTelemetryEvent>).detail);
    window.addEventListener(VIEW_RUNTIME_TELEMETRY_EVENT, handler);

    try {
      render(
        <KeepAliveViewHost
          activeViewId="runtime-probe"
          renderView={() => <CalmView />}
        />,
      );

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            viewId: "runtime-probe",
            phase: "active",
            reason: "show",
          }),
        ]),
      );
    } finally {
      window.removeEventListener(VIEW_RUNTIME_TELEMETRY_EVENT, handler);
    }
  });

  it("flags a per-view render storm without flagging a calm sibling", () => {
    registerViewPolicy("calm", { keepAlive: true });
    registerViewPolicy("storm", { keepAlive: true });

    const events: AnyRenderTelemetryEvent[] = [];
    const handler = (e: Event) =>
      events.push((e as CustomEvent<AnyRenderTelemetryEvent>).detail);
    window.addEventListener(RENDER_TELEMETRY_EVENT, handler);

    const renderView = (id: string) =>
      id === "storm" ? <StormView bursts={80} /> : <CalmView />;

    // Mount calm first (retained), then storm active.
    const { rerender } = render(
      <KeepAliveViewHost activeViewId="calm" renderView={renderView} />,
    );
    act(() => {
      rerender(
        <KeepAliveViewHost activeViewId="storm" renderView={renderView} />,
      );
    });

    window.removeEventListener(RENDER_TELEMETRY_EVENT, handler);

    const stormEvents = events.filter((e) => e.name === "storm");
    const calmEvents = events.filter((e) => e.name === "calm");
    // The storm view crossed the INFO threshold (>=60 commits/1s window).
    expect(stormEvents.length).toBeGreaterThanOrEqual(1);
    // The calm sibling never stormed.
    expect(calmEvents.length).toBe(0);
  });
});

describe("KeepAliveViewHost — keep-alive retention + bounded eviction", () => {
  it("retains a keep-alive view hidden across a switch, then back", () => {
    registerViewPolicy("a", { keepAlive: true });
    registerViewPolicy("b", { keepAlive: true });
    const renderView = (id: string) => (
      <div data-testid={`view-${id}`}>{id}</div>
    );

    const { rerender, container } = render(
      <KeepAliveViewHost activeViewId="a" renderView={renderView} />,
    );
    expect(container.querySelector('[data-testid="view-a"]')).toBeTruthy();

    act(() => {
      rerender(<KeepAliveViewHost activeViewId="b" renderView={renderView} />);
    });
    // Both retained (keepAlive); a is now hidden but still in the DOM.
    const aSlot = container.querySelector('[data-view-lifecycle-slot="a"]');
    expect(aSlot).toBeTruthy();
    expect(aSlot?.getAttribute("data-view-hidden")).toBe("true");
    expect(viewLifecycleController.getPhase("a")).toBe("paused");
    expect(viewLifecycleController.getPhase("b")).toBe("active");
  });

  it("unmounts a default (non-keepAlive) view on hide", () => {
    const renderView = (id: string) => (
      <div data-testid={`view-${id}`}>{id}</div>
    );
    const { rerender, container } = render(
      <KeepAliveViewHost activeViewId="x" renderView={renderView} />,
    );
    act(() => {
      rerender(<KeepAliveViewHost activeViewId="y" renderView={renderView} />);
    });
    // x is non-keepAlive → fully unmounted (no slot, no phase).
    expect(
      container.querySelector('[data-view-lifecycle-slot="x"]'),
    ).toBeNull();
    expect(viewLifecycleController.getPhase("x")).toBeNull();
  });
});

describe("KeepAliveViewHost — pause stops timers", () => {
  it("drops the pending-timer count when the view is paused (hidden)", () => {
    vi.useFakeTimers();
    try {
      registerViewPolicy("timer-view", { keepAlive: true, pausable: true });
      registerViewPolicy("other", { keepAlive: true });
      const renderView = (id: string) =>
        id === "timer-view" ? <TimerView /> : <div data-testid="other" />;

      const { rerender } = render(
        <KeepAliveViewHost activeViewId="timer-view" renderView={renderView} />,
      );
      // Active: the pausable interval is live → 1 pending timer.
      expect(snapshotResourceCounters("timer-view").pendingTimers).toBe(1);

      act(() => {
        rerender(
          <KeepAliveViewHost activeViewId="other" renderView={renderView} />,
        );
      });
      // Hidden+paused: the interval is torn down → 0 pending timers (no leak).
      expect(snapshotResourceCounters("timer-view").pendingTimers).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
