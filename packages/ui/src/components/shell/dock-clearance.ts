/**
 * Publish how much of the bottom of a screen its floating docks cover (a chat
 * composer with whatever is stacked on it, or a pill), measured in the
 * screen's own layout pixels, as CSS custom properties on the root element.
 *
 * Docks float over the page, so scrolling content needs bottom padding (and
 * scroll padding) of exactly that footprint: a fixed number is either too
 * small once the dock grows (large text, a longer draft, a status row) and the
 * last row of content is drawn under it, or too large and wastes the screen,
 * and the native navigation inset moves the dock independently. Two lengths
 * are published: `clearanceProperty`, everything the docks cover now, and
 * `restProperty`, the resting bar alone.
 *
 * Measurements use layout offsets, not bounding rects, so an entrance slide or
 * a dragged sheet never resizes the content behind it mid-animation. While no
 * dock is on screen (covered by a shade or a modal, or retired behind `inert`)
 * the last footprint is kept, so content does not jump when the dock returns.
 */

export interface DockClearanceOptions {
  /**
   * Selector of the screen element the docks float over (the measurement
   * origin). It must be positioned (an `offsetParent` of every dock): a dock
   * whose offset chain does not reach it measures as 0 and nothing is
   * published for it.
   */
  screen: string;
  /** Selector of every dock element. */
  docks: string;
  /** Selector, inside a dock, of its resting bar; defaults to the dock itself. */
  bar?: string;
  /** Custom property for everything the docks cover now, e.g. `--app-dock-clearance`. */
  clearanceProperty: string;
  /** Custom property for the resting bar alone; omitted when not needed. */
  restProperty?: string;
  /** Element whose style receives the properties (default `document.documentElement`). */
  target?: HTMLElement;
}

export interface DockClearance {
  /** Everything the visible docks cover, in screen pixels. */
  clearance: number;
  /** The resting bars alone, never more than `clearance`. */
  rest: number;
}

/** Docks on screen now: rendered and not retired behind an `inert` layer. */
export function visibleDocks(root: ParentNode, docks: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(docks)).filter(
    (dock) => dock.getClientRects().length > 0 && !dock.closest("[inert]"),
  );
}

/** Distance from `element`'s layout top to the bottom of `screen`, or 0 when it is not inside. */
function coveredBelow(screen: HTMLElement, element: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = element;
  while (node && node !== screen) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return node === screen ? screen.clientHeight - top : 0;
}

/**
 * Measure the footprint of `docks` over `screen`, or null when nothing is
 * measurable (no dock, a dock outside the screen, or a zero-height result).
 */
export function measureDockClearance(
  screen: HTMLElement,
  docks: readonly HTMLElement[],
  bar?: string,
): DockClearance | null {
  if (!docks.length) return null;
  const clearance = Math.ceil(
    Math.max(...docks.map((dock) => coveredBelow(screen, dock))),
  );
  const rest = Math.ceil(
    Math.max(
      ...docks.map((dock) =>
        coveredBelow(
          screen,
          (bar ? dock.querySelector<HTMLElement>(bar) : null) ?? dock,
        ),
      ),
    ),
  );
  if (
    !Number.isFinite(clearance) ||
    clearance <= 0 ||
    !Number.isFinite(rest) ||
    rest <= 0
  )
    return null;
  return { clearance, rest: Math.min(rest, clearance) };
}

/**
 * Keep the dock footprint published while the page runs. Docks appear, grow,
 * change kind and leave with the view, so the publisher watches the document,
 * the docks' sizes, the root's class/style (insets and scale arrive there),
 * window resizes and the end of the docks' own animations. A change inside a
 * dock, and a dock being inserted or removed, is published in the same
 * observer delivery, before its new height can cover controls; anything else
 * is coalesced to the next frame. Returns the
 * uninstaller, which also removes the published properties.
 */
export function installDockClearance(
  options: DockClearanceOptions,
): () => void {
  const target = options.target ?? document.documentElement;
  let published = "";
  let frame = 0;
  let watched: HTMLElement[] = [];
  const sizes = new ResizeObserver(() => readNow());
  const read = () => {
    frame = 0;
    const screen = document.querySelector<HTMLElement>(options.screen);
    if (!screen?.offsetWidth) return;
    const docks = visibleDocks(screen, options.docks);
    if (
      docks.length !== watched.length ||
      docks.some((dock, index) => dock !== watched[index])
    ) {
      sizes.disconnect();
      sizes.observe(screen);
      for (const dock of docks) sizes.observe(dock);
      watched = docks;
    }
    const measured = measureDockClearance(screen, docks, options.bar);
    if (!measured) return;
    const next = `${measured.clearance}/${measured.rest}`;
    if (next === published) return;
    published = next;
    target.style.setProperty(
      options.clearanceProperty,
      `${measured.clearance}px`,
    );
    if (options.restProperty)
      target.style.setProperty(options.restProperty, `${measured.rest}px`);
  };
  const readNow = () => {
    if (frame) cancelAnimationFrame(frame);
    read();
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(read);
  };
  // A mutation inside a dock, or a dock inserted or removed (whose record's
  // target is the dock's parent), is read in the same delivery.
  const touchesDock = (node: Node): boolean =>
    node instanceof Element &&
    (node.matches(options.docks) || !!node.querySelector(options.docks));
  const changes = new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          (record.target instanceof Element &&
            !!record.target.closest(options.docks)) ||
          Array.from(record.addedNodes).some(touchesDock) ||
          Array.from(record.removedNodes).some(touchesDock),
      )
    )
      readNow();
    else schedule();
  });
  changes.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["inert"],
  });
  const root = new MutationObserver(schedule);
  root.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  window.addEventListener("resize", schedule);
  document.addEventListener("animationend", schedule, true);
  document.addEventListener("transitionend", schedule, true);
  read();
  return () => {
    changes.disconnect();
    root.disconnect();
    sizes.disconnect();
    window.removeEventListener("resize", schedule);
    document.removeEventListener("animationend", schedule, true);
    document.removeEventListener("transitionend", schedule, true);
    if (frame) cancelAnimationFrame(frame);
    target.style.removeProperty(options.clearanceProperty);
    if (options.restProperty) target.style.removeProperty(options.restProperty);
  };
}
