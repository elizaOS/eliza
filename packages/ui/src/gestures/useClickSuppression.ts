/**
 * Swallow the compat `click` the browser synthesizes from a committed pointer
 * gesture (a swipe/flick/long-press), so the same press doesn't also tap-launch
 * the element under the release point.
 *
 * One mechanism for every consumer (pager, topic-group toggle, conversation
 * long-press): call `arm()` when the gesture commits, attach `onClickCapture` to
 * the same element as the pointer handlers. The arm auto-disarms on a microtask
 * so a genuine later click is never eaten; it also disarms the instant it
 * swallows one synthesized click.
 */

import * as React from "react";

export interface ClickSuppressionOptions {
  /**
   * When true (default), an `arm()` that is never followed by a synthesized
   * click auto-disarms on the next macrotask, so a stale arm can't eat an
   * unrelated later click. Surfaces whose synthesized click arrives as a
   * SEPARATE native event after `arm()` (a touch long-press, where the click
   * may land a full task later) pass `false` and rely on consume-on-click only.
   */
  autoDisarm?: boolean;
}

export interface ClickSuppression {
  /** Mark that a gesture just committed — the next synthesized click is swallowed. */
  arm: () => void;
  /** Attach to the gesture element's `onClickCapture`. */
  onClickCapture: (event: React.MouseEvent) => void;
  /** Read (and consume) the armed state directly, for handlers that own their
   *  own onClick and must decide inline whether to no-op. */
  consumeArmed: () => boolean;
}

export function useClickSuppression(
  options: ClickSuppressionOptions = {},
): ClickSuppression {
  const { autoDisarm = true } = options;
  const armed = React.useRef(false);
  const autoDisarmRef = React.useRef(autoDisarm);
  autoDisarmRef.current = autoDisarm;

  const arm = React.useCallback(() => {
    armed.current = true;
    if (!autoDisarmRef.current) return;
    // Auto-disarm on a macrotask so a later, unrelated click is never eaten if
    // no synthesized click arrives (some gesture ends produce none).
    setTimeout(() => {
      armed.current = false;
    }, 0);
  }, []);

  const onClickCapture = React.useCallback((event: React.MouseEvent) => {
    if (!armed.current) return;
    armed.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const consumeArmed = React.useCallback(() => {
    if (!armed.current) return false;
    armed.current = false;
    return true;
  }, []);

  return { arm, onClickCapture, consumeArmed };
}
