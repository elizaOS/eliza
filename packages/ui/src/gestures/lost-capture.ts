/**
 * Distinguish a real capture loss on the bound element from a descendant's
 * implicit-capture handoff that merely BUBBLED up.
 *
 * `lostpointercapture` bubbles. A swipe that STARTS on an interactive/selectable
 * child (a message bubble, a widget-card button) gives that child
 * implicit pointer capture on pointerdown; when the surface then calls
 * `setPointerCapture` at axis-commit, the child fires `lostpointercapture`, which
 * bubbles here. Treating that as a cancel aborts the swipe the instant it
 * commits. Only a capture loss on the bound element ITSELF (`target ===
 * currentTarget` — device rotation / OS takeover) should settle the gesture.
 */

import type * as React from "react";

export function isRealCaptureLoss(event: React.PointerEvent): boolean {
  return event.target === event.currentTarget;
}
