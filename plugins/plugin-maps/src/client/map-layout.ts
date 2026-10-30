/** Fit inside the largest rectangle not covered by canonical MapsScreen controls.
 * Flow controls outside the plane reserve no space. The root also owns the
 * navigation actions, which are siblings of the map's scroll container. */
export function visibleMapPadding(container: HTMLElement) {
  const map = container.getBoundingClientRect();
  const root =
    container.closest?.("[data-maps-root]") ?? container.parentElement;
  // DOM rectangles include a host transform; MapLibre and CSS insets use layout pixels.
  const scaleX =
    map.width > 0 ? (container.clientWidth || map.width) / map.width : 1;
  const scaleY =
    map.height > 0 ? (container.clientHeight || map.height) / map.height : 1;
  const horizontal = Math.min(24 / scaleX, map.width / 4);
  const vertical = Math.min(24 / scaleY, map.height / 4);
  const frame = {
    left: map.left + horizontal,
    right: map.right - horizontal,
    top: map.top + vertical,
    bottom: map.bottom - vertical,
  };
  const primary =
    root?.querySelector("[data-maps-primary]") ??
    root?.querySelector("[data-maps-search]");
  const overlays = [
    [primary, 16],
    [root?.querySelector("[data-maps-credits]"), 16],
    [root?.querySelector("[data-maps-sheet]"), 24],
    [root?.querySelector("[data-maps-navigation-controls]"), 16],
  ] as const;
  const boxes = overlays.flatMap(([element, gap]) => {
    const box = element?.getBoundingClientRect();
    if (
      !box ||
      box.width === 0 ||
      box.height === 0 ||
      box.right <= map.left ||
      box.left >= map.right ||
      box.bottom <= map.top ||
      box.top >= map.bottom
    )
      return [];
    const clipped = {
      left: Math.max(frame.left, box.left - gap / scaleX),
      right: Math.min(frame.right, box.right + gap / scaleX),
      top: Math.max(frame.top, box.top - gap / scaleY),
      bottom: Math.min(frame.bottom, box.bottom + gap / scaleY),
    };
    return clipped.right > clipped.left && clipped.bottom > clipped.top
      ? [clipped]
      : [];
  });
  const xs = [
    ...new Set([
      frame.left,
      frame.right,
      ...boxes.flatMap((box) => [box.left, box.right]),
    ]),
  ].sort((a, b) => a - b);
  const ys = [
    ...new Set([
      frame.top,
      frame.bottom,
      ...boxes.flatMap((box) => [box.top, box.bottom]),
    ]),
  ].sort((a, b) => a - b);
  let best = frame,
    area = 0;
  for (let left = 0; left < xs.length - 1; left++)
    for (let right = left + 1; right < xs.length; right++) {
      for (let top = 0; top < ys.length - 1; top++)
        for (let bottom = top + 1; bottom < ys.length; bottom++) {
          const candidate = {
            left: xs[left],
            right: xs[right],
            top: ys[top],
            bottom: ys[bottom],
          };
          if (
            boxes.some(
              (box) =>
                candidate.left < box.right &&
                candidate.right > box.left &&
                candidate.top < box.bottom &&
                candidate.bottom > box.top,
            )
          )
            continue;
          const size =
            (candidate.right - candidate.left) *
            (candidate.bottom - candidate.top);
          if (size > area) {
            best = candidate;
            area = size;
          }
        }
    }
  return {
    top: (best.top - map.top) * scaleY,
    bottom: (map.bottom - best.bottom) * scaleY,
    left: (best.left - map.left) * scaleX,
    right: (map.right - best.right) * scaleX,
  };
}
