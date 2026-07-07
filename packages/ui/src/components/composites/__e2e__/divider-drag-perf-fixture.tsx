/**
 * A/B fixture for the divider-drag frame gate. Two resize dividers control the
 * width of an identical heavy widget body (many subscribed rows, the stand-in
 * for the real WidgetHost subtree that a chat-page divider reflows):
 *
 *   - LEGACY divider: the pre-fix handler pattern — a raw pointermove writes
 *     React state AND synchronously persists to localStorage on every event,
 *     and the width is applied inline as a style prop so the whole heavy body
 *     re-renders and reflows per pointer event (up to ~1000Hz).
 *   - SHIPPED divider: the fixed pattern — width is written straight onto the
 *     panel element via a rAF coalescer (at most once per frame), and React
 *     state + localStorage commit once, on release.
 *
 * The runner drives an identical staged drag on each and compares real
 * PerformanceObserver frame stats plus the render-commit and localStorage-write
 * counts each pattern produced. Only the divider HANDLER differs between the two
 * columns; the body is byte-identical, so the frame delta is the fix.
 */

import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useRafCoalescer } from "../../../gestures";

const MIN_WIDTH = 240;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 320;
const HEAVY_ROWS = 90;

// Counters the runner reads to prove the mechanical contract (not just fps):
// how many times each body re-rendered and how many localStorage writes fired.
declare global {
  interface Window {
    __DIVIDER_METRICS__: {
      legacyRenders: number;
      shippedRenders: number;
      legacyStorageWrites: number;
      shippedStorageWrites: number;
    };
  }
}
window.__DIVIDER_METRICS__ = {
  legacyRenders: 0,
  shippedRenders: 0,
  legacyStorageWrites: 0,
  shippedStorageWrites: 0,
};

function persist(key: string, value: number, which: "legacy" | "shipped") {
  try {
    window.localStorage.setItem(key, String(value));
  } catch (error) {
    void error;
  }
  if (which === "legacy") window.__DIVIDER_METRICS__.legacyStorageWrites += 1;
  else window.__DIVIDER_METRICS__.shippedStorageWrites += 1;
}

/** A deliberately heavy body: many rows with gradients + shadows so a re-render
 *  costs real layout/paint, standing in for the chat WidgetHost subtree. */
function HeavyBody({ which }: { which: "legacy" | "shipped" }) {
  if (which === "legacy") window.__DIVIDER_METRICS__.legacyRenders += 1;
  else window.__DIVIDER_METRICS__.shippedRenders += 1;
  const rows = [];
  for (let i = 0; i < HEAVY_ROWS; i += 1) {
    rows.push(
      <div
        key={i}
        style={{
          height: 18,
          margin: "2px 6px",
          borderRadius: 4,
          background: `linear-gradient(90deg, hsl(${(i * 7) % 360} 60% 30%), hsl(${(i * 7 + 40) % 360} 60% 22%))`,
          boxShadow: "inset 0 0 4px rgba(0,0,0,0.4)",
        }}
      >
        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.6)" }}>
          row {i}
        </span>
      </div>,
    );
  }
  return <div style={{ overflow: "hidden" }}>{rows}</div>;
}

/** Pre-fix pattern: setState + synchronous localStorage per pointermove, width
 *  applied inline so the heavy body re-renders and reflows each event. */
function LegacyDivider() {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      const onMove = (ev: PointerEvent) => {
        const next = Math.min(
          Math.max(startWidth - (ev.clientX - startX), MIN_WIDTH),
          MAX_WIDTH,
        );
        setWidth(next);
        persist("perf:legacy:width", next, "legacy");
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width],
  );
  return (
    <aside
      data-testid="legacy-bar"
      style={{ position: "relative", width, minWidth: width, flexShrink: 0 }}
    >
      <div
        data-testid="legacy-handle"
        onPointerDown={onPointerDown}
        style={{
          position: "absolute",
          insetBlock: 0,
          left: -6,
          width: 12,
          cursor: "col-resize",
          touchAction: "none",
          background: "rgba(240,178,50,0.25)",
        }}
      />
      <HeavyBody which="legacy" />
    </aside>
  );
}

/** Shipped pattern: rAF-coalesced ref write during the drag, one React state +
 *  localStorage commit on release (mirrors TasksEventsPanel). */
function ShippedDivider() {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const barRef = useRef<HTMLElement | null>(null);
  const { schedule, flush, cancel } = useRafCoalescer<number>((next) => {
    const el = barRef.current;
    if (!el) return;
    el.style.width = `${next}px`;
    el.style.minWidth = `${next}px`;
  });
  const commit = useCallback((next: number) => {
    setWidth(next);
    persist("perf:shipped:width", next, "shipped");
  }, []);
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      let lastApplied: number | null = null;
      const onMove = (ev: PointerEvent) => {
        lastApplied = Math.min(
          Math.max(startWidth - (ev.clientX - startX), MIN_WIDTH),
          MAX_WIDTH,
        );
        schedule(lastApplied);
      };
      const onEnd = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        flush();
        if (lastApplied !== null) commit(lastApplied);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      return cancel;
    },
    [cancel, commit, flush, schedule, width],
  );
  return (
    <aside
      ref={barRef}
      data-testid="shipped-bar"
      style={{ position: "relative", width, minWidth: width, flexShrink: 0 }}
    >
      <div
        data-testid="shipped-handle"
        onPointerDown={onPointerDown}
        style={{
          position: "absolute",
          insetBlock: 0,
          left: -6,
          width: 12,
          cursor: "col-resize",
          touchAction: "none",
          background: "rgba(240,178,50,0.25)",
        }}
      />
      <HeavyBody which="shipped" />
    </aside>
  );
}

function Fixture() {
  return (
    <div
      data-testid="divider-perf-root"
      style={{ display: "flex", gap: 40, padding: 24, height: "100vh" }}
    >
      <div style={{ flex: 1 }} />
      <LegacyDivider />
      <div style={{ width: 40 }} />
      <ShippedDivider />
    </div>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("fixture: #root missing");
createRoot(rootEl).render(<Fixture />);
