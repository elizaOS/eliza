import type * as React from "react";

// A flat warm-orange field whose EDGE slowly breathes through our palette —
// white → orange → blue → black and back — as a soft inset glow from the screen
// perimeter inward. The center stays clean orange; only the rim shifts color.
//
// Smoothness: each rim color is a SEPARATE layer with a STATIC inset box-shadow
// (painted once), and the breathing is a pure `opacity` crossfade between them.
// opacity is compositor-only, so the rim animates without repainting the
// full-viewport box-shadow every frame (the old single-layer `box-shadow`
// keyframe was a per-frame paint, not "compositor-cheap"). Fully stilled under
// prefers-reduced-motion. This is the /chat ambient home only; the
// BackgroundHost "no animated shell bg" stance holds elsewhere.
const EDGE_CSS = `
@keyframes chat-amb-0 { 0%{opacity:1} 25%{opacity:0} 75%{opacity:0} 100%{opacity:1} }
@keyframes chat-amb-1 { 0%{opacity:0} 25%{opacity:1} 50%{opacity:0} 100%{opacity:0} }
@keyframes chat-amb-2 { 25%{opacity:0} 50%{opacity:1} 75%{opacity:0} }
@keyframes chat-amb-3 { 50%{opacity:0} 75%{opacity:1} 100%{opacity:0} }
.chat-amb-layer {
  position: absolute;
  inset: 0;
  will-change: opacity;
  animation-duration: 30s;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
.chat-amb-0 { box-shadow: inset 0 0 160px 8px rgba(255, 248, 240, 0.34); animation-name: chat-amb-0; }  /* white */
.chat-amb-1 { box-shadow: inset 0 0 150px 6px rgba(255, 130, 56, 0.30); animation-name: chat-amb-1; }   /* orange */
.chat-amb-2 { box-shadow: inset 0 0 170px 10px rgba(46, 96, 210, 0.34); animation-name: chat-amb-2; }   /* blue */
.chat-amb-3 { box-shadow: inset 0 0 180px 14px rgba(6, 5, 10, 0.46); animation-name: chat-amb-3; }      /* black */
@media (prefers-reduced-motion: reduce) {
  .chat-amb-layer { animation: none; opacity: 0; }
  .chat-amb-1 { opacity: 1; box-shadow: inset 0 0 150px 6px rgba(255, 130, 56, 0.22); }
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
      // FIXED (not absolute) so the orange fills the TRUE viewport — under the
      // edge-to-edge status bar too — instead of being inset by the shell's
      // safe-area padding (which left a black status-bar band above the field).
      // Only mounts on /chat, so it never bleeds into other views.
      className="pointer-events-none fixed inset-0 overflow-hidden"
      // Flat warm-orange base — no gradient, no vignette. The only movement is
      // the slow edge pulse (opacity crossfade) layered on top.
      style={{ zIndex: 0, backgroundColor: "#ef5a1f" }}
    >
      <style>{EDGE_CSS}</style>
      <div className="chat-amb-layer chat-amb-0" />
      <div className="chat-amb-layer chat-amb-1" />
      <div className="chat-amb-layer chat-amb-2" />
      <div className="chat-amb-layer chat-amb-3" />
    </div>
  );
}
