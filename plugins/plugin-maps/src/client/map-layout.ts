/** Space covered by the canonical MapsScreen controls. Controls outside the map
 * reserve no space; short viewports retain room for the camera bounds. */
export function visibleMapPadding(container: HTMLElement) {
  const map = container.getBoundingClientRect();
  const parent = container.parentElement;
  const inset = { top: 24, bottom: 24, left: 24, right: 24 };
  const overlap = (selector: string) => {
    const box = parent?.querySelector(selector)?.getBoundingClientRect();
    return box &&
      box.right > map.left &&
      box.left < map.right &&
      box.bottom > map.top &&
      box.top < map.bottom
      ? box
      : null;
  };
  const header = overlap("[data-maps-search]");
  const credits = overlap("[data-maps-credits]");
  const sheet = overlap("[data-maps-sheet]");
  if (header) inset.top = Math.max(inset.top, header.bottom - map.top + 16);
  if (credits)
    inset.bottom = Math.max(inset.bottom, map.bottom - credits.top + 16);
  if (sheet) {
    if (sheet.left > map.left + map.width * 0.35)
      inset.right = Math.max(inset.right, map.right - sheet.left + 24);
    else inset.bottom = Math.max(inset.bottom, map.bottom - sheet.top + 24);
  }
  for (const [start, end, length] of [
    ["top", "bottom", map.height],
    ["left", "right", map.width],
  ] as const) {
    const total = inset[start] + inset[end];
    const available = Math.max(0, length - Math.min(80, length / 2));
    if (total > available) {
      const scale = available / total;
      inset[start] *= scale;
      inset[end] *= scale;
    }
  }
  return inset;
}
