/** Identifies controls whose pointer gestures belong to the control, not its surrounding surface. */
export function isInteractiveGestureTarget(
  target: EventTarget | null,
): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "button, a, input, textarea, select, [role='button'], [contenteditable='true']",
    ) !== null
  );
}
