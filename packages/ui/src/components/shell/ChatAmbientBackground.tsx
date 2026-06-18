import type * as React from "react";

// A flat warm-orange field whose EDGE slowly breathes through our palette —
// white → orange → blue → black and back — as a soft inset glow from the screen
// perimeter inward. The center stays clean orange; only the rim shifts color.
// Pure CSS keyframes on an inset box-shadow (compositor-cheap, no rAF / canvas /
// <video>), fully stilled under prefers-reduced-motion. This is the /chat
// ambient home only; the BackgroundHost "no animated shell bg" stance holds
// elsewhere.
const EDGE_CSS = `
@keyframes chat-ambient-edge {
  0%   { box-shadow: inset 0 0 160px 8px rgba(255, 248, 240, 0.34); } /* white */
  25%  { box-shadow: inset 0 0 150px 6px rgba(255, 130, 56, 0.30); }  /* orange */
  50%  { box-shadow: inset 0 0 170px 10px rgba(46, 96, 210, 0.34); }  /* blue */
  75%  { box-shadow: inset 0 0 180px 14px rgba(6, 5, 10, 0.46); }     /* black */
  100% { box-shadow: inset 0 0 160px 8px rgba(255, 248, 240, 0.34); }
}
.chat-ambient-edge {
  animation: chat-ambient-edge 30s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .chat-ambient-edge {
    animation: none;
    box-shadow: inset 0 0 150px 6px rgba(255, 130, 56, 0.22);
  }
}
`;

/**
 * The ambient backdrop for the /chat conversational home — a flat orange field
 * with a gentle, living color pulse around the edges. No gradient, no vignette,
 * no greeting text (the home is wordless behind the always-present chat).
 */
export function ChatAmbientBackground(): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      data-testid="chat-ambient-background"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      // Flat warm-orange base — no gradient, no vignette. The only movement is
      // the slow edge pulse layered on top.
      style={{ zIndex: 0, backgroundColor: "#ef5a1f" }}
    >
      <style>{EDGE_CSS}</style>
      <div className="chat-ambient-edge absolute inset-0" />
    </div>
  );
}
