import type * as React from "react";

// A warm orange field that breathes gently through blue → black → orange →
// white and back. Pure CSS keyframes on the `background-color` of a low-alpha
// overlay so the orange base always shows through and the shift stays subtle.
// No rAF / canvas / <video> — compositor-driven and cheap — and fully stilled
// under prefers-reduced-motion (the BackgroundHost "no animated shell bg" stance
// still holds; this is the /chat ambient home only).
const PULSE_CSS = `
@keyframes chat-ambient-pulse {
  0%   { background-color: rgba(46, 96, 210, 0.13); }   /* blue */
  25%  { background-color: rgba(8, 6, 12, 0.22); }      /* black */
  50%  { background-color: rgba(255, 130, 56, 0); }     /* orange (base shows) */
  75%  { background-color: rgba(255, 248, 240, 0.10); } /* white */
  100% { background-color: rgba(46, 96, 210, 0.13); }
}
.chat-ambient-pulse { animation: chat-ambient-pulse 32s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .chat-ambient-pulse { animation: none; background-color: rgba(255, 130, 56, 0); }
}
`;

/**
 * The ambient backdrop for the /chat conversational home — a tasteful, living
 * orange wash behind the always-present chat overlay. Replaces the old centered
 * time-of-day greeting text (the home is now wordless).
 */
export function ChatAmbientBackground(): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      data-testid="chat-ambient-background"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      // Flat warm-orange fill — no gradient, no vignette. The only movement is
      // the gentle, even hue pulse layered on top.
      style={{ zIndex: 0, backgroundColor: "#ef5a1f" }}
    >
      <style>{PULSE_CSS}</style>
      <div className="chat-ambient-pulse absolute inset-0" />
    </div>
  );
}
