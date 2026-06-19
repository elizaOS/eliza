import type * as React from "react";

// A warm-orange field whose EDGE slowly breathes between white and brand orange
// — a soft inset glow from the screen perimeter inward. The center stays a clean
// warm field; only the rim shifts. The old palette breathe cycled through a blue
// rim and a near-black rim; both are removed — blue is info-only (not decorative)
// and the black rim was literally darkening the home (the "too much black"
// complaint). The breathe is now warm-only (white ↔ #ff8a24 brand orange).
//
// Smoothness: each rim color is a SEPARATE layer with a STATIC inset box-shadow
// (painted once), and the breathing is a pure `opacity` crossfade between them.
// opacity is compositor-only, so the rim animates without repainting the
// full-viewport box-shadow every frame. Fully stilled under
// prefers-reduced-motion. This is the /chat ambient home only; the
// BackgroundHost "no animated shell bg" stance holds elsewhere.
const EDGE_CSS = `
@keyframes chat-amb-0 { 0%{opacity:1} 50%{opacity:0} 100%{opacity:1} }
@keyframes chat-amb-1 { 0%{opacity:0} 50%{opacity:1} 100%{opacity:0} }
.chat-amb-layer {
  position: absolute;
  inset: 0;
  /* No standing will-change: a running CSS opacity animation already self-promotes
     to its own compositor layer for its duration, so the hint bought nothing during
     motion and kept two full-viewport backing stores permanently promoted at rest
     (pure waste under prefers-reduced-motion, where the animation is off). */
  animation-duration: 30s;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
.chat-amb-0 { box-shadow: inset 0 0 170px 10px rgba(255, 250, 244, 0.42); animation-name: chat-amb-0; }  /* warm white */
.chat-amb-1 { box-shadow: inset 0 0 150px 6px rgba(255, 138, 36, 0.30); animation-name: chat-amb-1; }    /* brand orange #ff8a24 */
@media (prefers-reduced-motion: reduce) {
  .chat-amb-layer { animation: none; opacity: 0; }
  .chat-amb-1 { opacity: 1; box-shadow: inset 0 0 150px 6px rgba(255, 138, 36, 0.22); }
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
    </div>
  );
}
