/**
 * Responsive layout decisions from measured window geometry, not from the
 * screen's orientation (soft keyboard, rotation, large text).
 *
 * An Android `adjustResize` window shortens its layout viewport while the soft
 * keyboard is up, and Android keeps a focused field and its keyboard through a
 * rotation. Reading "wider than tall" straight from the window therefore flips
 * a portrait phone to a landscape arrangement as soon as the person types, and
 * the first measurement after turning a small phone back to portrait can still
 * be shorter than it is wide. {@link keyboardFreeHeight} keeps the height the
 * window has without the keyboard so a host can decide its arrangement from
 * that instead.
 *
 * {@link surfaceLayout} turns a measured content width and text scale into the
 * choices that change what a surface renders (a list-detail split, readable
 * calendar day columns, an agenda list at large text), so every view applies
 * the same responsive policy.
 */

/**
 * Track the window height without the soft keyboard for the current width.
 *
 * Call the returned function on every resize with the window's layout size and
 * whether a text field has focus. While the width is unchanged a shorter
 * height with a field focused is the keyboard, so the larger keyboard-free
 * height is kept. When the width changes while a field has focus and the new
 * width is about the previous keyboard-free height (within 20%), the sides
 * were swapped by a rotation: the previous width stands in for the new
 * keyboard-free height until the keyboard closes or the field loses focus.
 * Any other width change (a resized or split window) takes the measured height.
 */
export function keyboardFreeHeight(): (
  width: number,
  height: number,
  editing: boolean,
) => number {
  let base = { width: 0, height: 0 };
  return (width, height, editing) => {
    if (width === base.width) {
      if (!editing || height > base.height) base = { width, height };
    } else {
      const swapped =
        editing &&
        base.width > 0 &&
        Math.abs(width - base.height) <= base.height * 0.2;
      base = { width, height: swapped ? Math.max(height, base.width) : height };
    }
    return base.height;
  };
}

const NON_TEXT_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "range",
  "color",
  "file",
  "image",
  "hidden",
]);

/** True for focused text entry that raises a soft keyboard. */
export function raisesSoftKeyboard(element: Element | null): boolean {
  const view = element?.ownerDocument?.defaultView;
  if (!element || !view || !(element instanceof view.HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof view.HTMLTextAreaElement) return !element.readOnly;
  if (element instanceof view.HTMLInputElement)
    return !element.readOnly && !NON_TEXT_INPUT_TYPES.has(element.type);
  return false;
}

/** Layout choices that change what a surface renders, not only its CSS. */
export interface SurfaceLayout {
  /** Lists show the open item beside them (list-detail) instead of a stack. */
  split: boolean;
  /** Readable timed day columns a calendar shows (1 to `maxDays`). */
  calendarDays: number;
  /** Large text: a calendar shows the selected day as an agenda list. */
  agenda: boolean;
}

export interface SurfaceLayoutPolicy {
  /** Content width from which list-detail splits (default 1000). */
  splitWidth?: number;
  /** Narrowest readable day column at 100% text (default 240). */
  dayColumn?: number;
  /** Width a calendar's time gutter takes (default 76). */
  timeGutter?: number;
  /** Most day columns shown (default 7). */
  maxDays?: number;
  /** Text scale from which splits end and calendars show an agenda (default 1.5). */
  largeText?: number;
}

export const DEFAULT_SURFACE_LAYOUT: SurfaceLayout = Object.freeze({
  split: false,
  calendarDays: 1,
  agenda: false,
});

/**
 * The surface layout for a measured content width and text scale. Day columns
 * widen with the text they hold, so enlarged text gets fewer, readable columns;
 * from `largeText` the split returns to one pane and calendars show an agenda.
 * A fitted desktop preview (or an unmeasured width) keeps the phone layout.
 */
export function surfaceLayout(
  contentWidth: number,
  textScale: number,
  options: SurfaceLayoutPolicy & { desktop?: boolean } = {},
): SurfaceLayout {
  if (options.desktop || !Number.isFinite(contentWidth))
    return { ...DEFAULT_SURFACE_LAYOUT };
  const scale = Number.isFinite(textScale) && textScale > 0 ? textScale : 1;
  if (scale >= (options.largeText ?? 1.5))
    return { split: false, calendarDays: 1, agenda: true };
  const days = Math.floor(
    (contentWidth - (options.timeGutter ?? 76)) /
      ((options.dayColumn ?? 240) * Math.max(1, scale)),
  );
  return {
    split: contentWidth >= (options.splitWidth ?? 1000),
    calendarDays: Math.max(1, Math.min(options.maxDays ?? 7, days)),
    agenda: false,
  };
}

/** Whether two layouts render differently. */
export function sameSurfaceLayout(a: SurfaceLayout, b: SurfaceLayout): boolean {
  return (
    a.split === b.split &&
    a.calendarDays === b.calendarDays &&
    a.agenda === b.agenda
  );
}
