/**
 * Pure decision for the VRM render loop's pause + throttle state (#9141).
 *
 * The VRM avatar canvas is the heaviest GPU/battery cost in the app. Extracted
 * from VrmViewer (which pulls three.js) so the gating is unit-testable without a
 * WebGL context.
 *
 * - `paused`: stop the GPU loop entirely — the avatar produces no useful pixels
 *   when it's inactive, scrolled offscreen, or the tab is hidden (unless the user
 *   opted into animate-when-hidden). Offscreen always wins.
 * - `halfFramerateWhileHidden`: when the user DID opt into animate-when-hidden
 *   and the tab is hidden (but the canvas is still on the page + active), run at
 *   half rate instead of full — the one case where we keep rendering hidden.
 */
export interface VrmPausePolicyInput {
  /** The `active` prop — false while the avatar is logically off (e.g. collapsed). */
  active: boolean;
  /** Whether the canvas geometrically intersects the viewport. */
  onScreen: boolean;
  /** document.visibilityState === "visible". */
  docVisible: boolean;
  /** User opted into keeping the avatar animating while the tab is hidden. */
  animateHidden: boolean;
}

export interface VrmPausePolicy {
  paused: boolean;
  halfFramerateWhileHidden: boolean;
}

export function computeVrmPausePolicy(
  input: VrmPausePolicyInput,
): VrmPausePolicy {
  const { active, onScreen, docVisible, animateHidden } = input;
  return {
    paused: !active || !onScreen || (!docVisible && !animateHidden),
    halfFramerateWhileHidden:
      animateHidden && !docVisible && active && onScreen,
  };
}
