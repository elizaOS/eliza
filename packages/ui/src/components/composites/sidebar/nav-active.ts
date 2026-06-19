/**
 * Single shared "you-are-here" marker for the app shell.
 *
 * One idiom everywhere: a 3px accent edge + a soft `bg-accent/12` wash +
 * NEUTRAL text (`text-txt`). No orange-text-active, no bespoke underlines.
 *
 * - Vertical nav (sidebar items, collapsed rail): left edge.
 * - Horizontal nav (desktop tab bar, topbar buttons): bottom edge.
 */

/** Active marker for vertical navigation (left accent edge). */
export const navActiveClassVertical =
  "bg-accent/12 text-txt border-l-[3px] border-l-accent";

/** Active marker for horizontal navigation (bottom accent edge). */
export const navActiveClassHorizontal =
  "bg-accent/12 text-txt border-b-[3px] border-b-accent";

/** Default alias — vertical is the common case across the shell. */
export const navActiveClass = navActiveClassVertical;
