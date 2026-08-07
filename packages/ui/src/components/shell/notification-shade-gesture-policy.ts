/**
 * Gesture thresholds and DOM hit-testing policy for the notification shade.
 * The rendering surface consumes these decisions but does not own their timing
 * or pointer semantics.
 */

import { PULL_COMMIT_PX } from "./notification-shade-presentation";

export const MAX_RENDERED_ROWS = 100;
export const MAX_PULL_PREVIEW_GROUPS = 6;
export const EMPTY_PULL_COMMIT_PX = PULL_COMMIT_PX / 2;
export const SHADE_CLOSE_EDGE_PX = 40;
export const WHEEL_COLLAPSE_STEP_PX = PULL_COMMIT_PX / 2;
export const MAX_VISIBLE_STACK_LAYERS = 3;
export const STACK_PEEK_OFFSET_PX = 7;
export const STACK_BOTTOM_CLEARANCE_PX = 2;
export const CLEAR_CONFIRM_TIMEOUT_MS = 5_000;
export const POST_DRAG_CLICK_SUPPRESSION_MS = 180;
export const SHADE_SETTLE_MS = 460;
export const SHADE_MIN_SETTLE_MS = 320;
export const SHADE_MAX_SETTLE_MS = 600;
export const SHADE_MIN_SETTLE_SPEED_PX_PER_MS = 0.15;
export const SHADE_EASING = "cubic-bezier(0.25,0.1,0.25,1)";
export const WHEEL_COMMIT_LOCK_MS = SHADE_SETTLE_MS;
export const PULL_CANCEL_SETTLE_MS = SHADE_SETTLE_MS;
export const SHADE_MIN_FLICK_DISTANCE_PX = 22;
export const SHADE_FLICK_VELOCITY_PX_PER_MS = 0.45;
export const SHADE_MIN_VELOCITY_SAMPLE_MS = 16;
export const NOTIFICATION_COUNT_RESTORE_MS = SHADE_SETTLE_MS;

const INTERACTIVE_GESTURE_TARGET_SELECTOR =
  "button, a, input, textarea, select, [role='button'], [contenteditable='true']";

export function isInteractiveGestureTarget(
  target: EventTarget | null,
): boolean {
  return (
    target instanceof Element &&
    target.closest(INTERACTIVE_GESTURE_TARGET_SELECTOR) !== null
  );
}

export function isClickBelowNotificationCards(
  target: EventTarget | null,
  clientY: number,
  center: HTMLElement,
): boolean {
  if (!(target instanceof Node) || !center.contains(target)) return false;
  if (
    target instanceof Element &&
    target.closest("[data-notification-group]")
  ) {
    return false;
  }
  if (isInteractiveGestureTarget(target)) return false;
  const groups = center.querySelectorAll<HTMLElement>(
    "[data-notification-group]",
  );
  const lastGroup = groups.item(groups.length - 1);
  if (!lastGroup) return false;
  const bounds = lastGroup.getBoundingClientRect();
  return bounds.height > 0 && clientY > bounds.bottom;
}

export function touchWithIdentifier(
  touches: TouchList,
  identifier: number,
): Touch | undefined {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches[index];
    if (touch?.identifier === identifier) return touch;
  }
  return undefined;
}
