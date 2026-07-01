// Synthetic view-matrix fixture for the view-lifecycle e2e (#10202). Mounts the
// REAL KeepAliveViewHost + ViewLifecycleController over a set of synthetic views
// that each run a requestAnimationFrame loop, a pausable interval, and a tracked
// subscription — plus a render-storm view, a leaky view (subscription with no
// cleanup), and a crash-on-demand view. The runner drives switches + a crash and
// reads the controller / telemetry / per-view RAF+tick counters off `window`.
//
// Browser-safe import graph on purpose (the runner stubs @elizaos/core,
// @elizaos/logger, and node builtins) so esbuild can bundle it for chromium.

import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { KeepAliveViewHost } from "../KeepAliveViewHost";
import { trackSubscription } from "../../../perf/resource-counters";
import {
  registerViewPolicy,
  viewLifecycleController,
} from "../../../state/view-lifecycle";
import {
  usePauseAware,
  usePausableInterval,
} from "../../../state/useViewLifecycle";
import { readViewRuntimeTelemetry } from "../../../view-runtime-telemetry";

interface Win {
  __rafCounts: Record<string, number>;
  __tickCounts: Record<string, number>;
  __lifecycle: {
    switchTo: (id: string) => void;
    crash: () => void;
    uncrash: () => void;
    activeId: () => string;
    retained: () => string[];
    phases: () => Record<string, string | null>;
    telemetry: () => unknown[];
    heap: () => number | undefined;
    gc: () => void;
  };
}

declare const window: Window & typeof globalThis & Win;

window.__rafCounts = {};
window.__tickCounts = {};

// ── Synthetic views ────────────────────────────────────────────────────────

/** A normal view: a paused-aware RAF loop + a pausable interval + a tracked sub. */
function WorkView({ viewId }: { viewId: string }): React.JSX.Element {
  const { paused } = usePauseAware();
  usePausableInterval(() => {
    window.__tickCounts[viewId] = (window.__tickCounts[viewId] ?? 0) + 1;
  }, 50);

  useEffect(() => {
    // Tracked subscription with proper cleanup — a well-behaved view.
    const dispose = trackSubscription(viewId);
    return dispose;
  }, [viewId]);

  // RAF loop that stops while the view is paused (the media/RAF pause story).
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (paused) return;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      window.__rafCounts[viewId] = (window.__rafCounts[viewId] ?? 0) + 1;
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [viewId, paused]);

  return (
    <div
      data-testid={`work-${viewId}`}
      style={{ padding: 24, fontSize: 14, color: "#f4f4f5" }}
    >
      view {viewId} {paused ? "(paused)" : "(active)"}
    </div>
  );
}

/**
 * A view that commits ~90 times in quick succession to trip the per-view
 * rerender-storm telemetry. Uses async `setTimeout(0)` bumps (not synchronous
 * setState-in-effect) so each commit is its own task — many commits within the
 * 1s window without hitting React's max-update-depth guard.
 */
function StormView(): React.JSX.Element {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n < 90) {
      const id = setTimeout(() => setN((v) => v + 1), 0);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [n]);
  return <div data-testid="work-storm">storm {n}</div>;
}

/** A view that registers a subscription but NEVER disposes it — a real leak. */
function LeakyView(): React.JSX.Element {
  useEffect(() => {
    trackSubscription("leaky"); // disposer dropped on the floor
    // no cleanup returned → the counter never decrements
  }, []);
  return <div data-testid="work-leaky">leaky</div>;
}

let crashArmed = false;
function CrasherView(): React.JSX.Element {
  if (crashArmed) {
    throw new Error("INTENTIONAL_VIEW_CRASH");
  }
  return <div data-testid="work-crasher">crasher ok</div>;
}

// ── View registry + policies ─────────────────────────────────────────────────

const KEEP_ALIVE_VIEWS = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
  "storm",
  "leaky",
];
for (const id of KEEP_ALIVE_VIEWS) {
  registerViewPolicy(id, { keepAlive: true, pausable: true });
}
// crasher is a default (unmount-on-hide) view so its crash + recovery is the
// common case.

function renderView(viewId: string): React.ReactNode {
  if (viewId === "storm") return <StormView />;
  if (viewId === "leaky") return <LeakyView />;
  if (viewId === "crasher") return <CrasherView />;
  return <WorkView viewId={viewId} />;
}

function Harness(): React.JSX.Element {
  const [activeId, setActiveId] = useState("alpha");

  useEffect(() => {
    window.__lifecycle = {
      switchTo: (id) => setActiveId(id),
      crash: () => {
        crashArmed = true;
        setActiveId("crasher");
      },
      uncrash: () => {
        crashArmed = false;
      },
      activeId: () => viewLifecycleController.getActiveId() ?? "",
      retained: () => viewLifecycleController.getRetainedKeepAliveIds(),
      phases: () => {
        const out: Record<string, string | null> = {};
        for (const id of [...KEEP_ALIVE_VIEWS, "crasher"]) {
          out[id] = viewLifecycleController.getPhase(id);
        }
        return out;
      },
      telemetry: () => readViewRuntimeTelemetry(),
      heap: () => {
        const memory = (
          performance as Performance & { memory?: { usedJSHeapSize?: number } }
        ).memory;
        return memory?.usedJSHeapSize;
      },
      gc: () => {
        const g = (globalThis as { gc?: () => void }).gc;
        if (typeof g === "function") g();
      },
    };
  }, []);

  return (
    <div
      data-testid="lifecycle-harness"
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "#0a0d16",
      }}
    >
      <KeepAliveViewHost activeViewId={activeId} renderView={renderView} />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
