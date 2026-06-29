/**
 * Fixture for the perf-gate e2e (#9954, Item 5). Mounts the two REAL interaction
 * surfaces the gate drives, standalone (chromium-light — no app server, no full
 * overlay/shell state), so a headless browser can collect REAL rAF deltas +
 * longtask + layout-shift entries while it scrolls and swipes:
 *
 *   - perf-overlay-scroll — a tall, real overflow-y scroller (the overlay
 *     message-list mechanics): the surface the gate flings to measure scroll
 *     frame budget.
 *   - conversation-swiper — the REAL production `usePullGesture` wiring (the same
 *     hook + the same onDragX/onSwipeLeft/onSwipeRight binding the
 *     ContinuousChatOverlay uses for sheet-open conversation navigation), so the
 *     swipe window measures the actual gesture math, not a stand-in.
 *
 * The swiper is wrapped in `[data-eliza-layout-shift-intent="transient"]` so the
 * controlled swipe animation is treated as intentional motion (not page reflow)
 * by the shared layout-shift observer — only true reflow flags CLS.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import { usePullGesture } from "../use-pull-gesture";

/** A tall, real overflow-y scroller — the overlay message-list mechanics. */
function OverlayScroll(): React.JSX.Element {
  const rows = Array.from({ length: 200 }, (_, i) => i);
  return (
    <div
      data-testid="perf-overlay-scroll"
      style={{ height: 520, overflowY: "auto", overscrollBehavior: "contain" }}
      className="rounded-2xl border border-white/10 bg-white/5 p-3"
    >
      {rows.map((i) => (
        <div
          key={i}
          className="mb-2 whitespace-pre-wrap text-[13px] leading-relaxed text-white/80"
        >
          {`message ${i} — ${"lorem ".repeat(12)}`}
        </div>
      ))}
    </div>
  );
}

const CONVERSATIONS = [
  "Deployment thread — provisioning the worker",
  "Billing thread — overdrawn alert follow-up",
  "Latency thread — p95 frame budget regression",
  "Design review — launcher hero icons",
];

/**
 * Conversation-swipe surface bound to the REAL `usePullGesture` (mirrors
 * ContinuousChatOverlay's conversationSwipe: live `onDragX` offset +
 * `onSwipeLeft`/`onSwipeRight` advancing the index). The rail translates with the
 * live drag offset and snaps on commit — the same per-frame transform work the
 * gate measures for jank.
 */
function ConversationSwiper(): React.JSX.Element {
  const [index, setIndex] = React.useState(0);
  const [dx, setDx] = React.useState(0);

  const swipe = usePullGesture({
    onDragX: (offset) => setDx(offset),
    onSwipeLeft: () => {
      setDx(0);
      setIndex((i) => Math.min(CONVERSATIONS.length - 1, i + 1));
    },
    onSwipeRight: () => {
      setDx(0);
      setIndex((i) => Math.max(0, i - 1));
    },
  });

  return (
    <div
      data-testid="conversation-swiper"
      onPointerDown={swipe.onPointerDown}
      onPointerMove={swipe.onPointerMove}
      onPointerUp={swipe.onPointerUp}
      onPointerCancel={swipe.onPointerCancel}
      onLostPointerCapture={swipe.onLostPointerCapture}
      style={{
        position: "relative",
        height: 140,
        overflow: "hidden",
        touchAction: "pan-y",
      }}
      className="rounded-2xl border border-white/10 bg-white/5"
    >
      <div
        data-testid="conversation-swiper-rail"
        style={{
          // `dx` is positive when dragging LEFT (usePullGesture convention), so a
          // left drag pulls the rail left — the real overlay's swipe morph.
          transform: `translateX(${-dx}px)`,
          height: "100%",
          display: "flex",
          alignItems: "center",
          padding: "0 20px",
        }}
      >
        <div className="text-[15px] font-medium text-white/90">
          {CONVERSATIONS[index]}
        </div>
      </div>
    </div>
  );
}

function App(): React.JSX.Element {
  return (
    <div
      data-testid="perf-gate-root"
      style={{
        maxWidth: 560,
        margin: "0 auto",
        padding: 24,
        color: "white",
        minHeight: "100vh",
        background:
          "radial-gradient(120% 120% at 50% 0%, #2a2233 0%, #16121c 100%)",
        display: "flex",
        flexDirection: "column",
        gap: 20,
      }}
    >
      <OverlayScroll />
      <div data-eliza-layout-shift-intent="transient">
        <ConversationSwiper />
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
