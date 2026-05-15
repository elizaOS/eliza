/**
 * Token-efficient Scene serializer.
 *
 * Used by the `scene` provider to render the current Scene into the agent
 * prompt. We deliberately cap lists by display so a 4k-monitor session
 * doesn't push the prompt to thousands of tokens:
 *
 *   - displays              : full list (small)
 *   - focused_window        : full (small)
 *   - apps                  : pid, name, window count, top-2 window titles
 *   - ocr                   : top-N most-confident lines per display
 *                             (default N = 24, configurable)
 *   - ax                    : limited to the focused window's display subtree
 *                             (default cap = 24)
 *   - vlm_scene / elements  : passed through verbatim
 *
 * The output is fenced JSON for predictable downstream tokenization.
 */

import type { Scene } from "./scene-types.js";

export interface SerializeOptions {
  ocrTopN?: number;
  axMax?: number;
  appTopWindows?: number;
  /** Cap total apps emitted. Prefers apps with at least one visible window. */
  appMax?: number;
}

export function serializeSceneForPrompt(
  scene: Scene,
  options: SerializeOptions = {},
): string {
  const ocrTopN = options.ocrTopN ?? 24;
  const axMax = options.axMax ?? 24;
  const appTopWindows = options.appTopWindows ?? 2;
  const appMax = options.appMax ?? 32;

  // OCR: per-display, sorted by descending confidence, capped.
  const ocrByDisplay = new Map<number, typeof scene.ocr>();
  for (const box of scene.ocr) {
    const arr = ocrByDisplay.get(box.displayId) ?? [];
    arr.push(box);
    ocrByDisplay.set(box.displayId, arr);
  }
  const trimmedOcr: typeof scene.ocr = [];
  for (const [, arr] of ocrByDisplay) {
    arr.sort((a, b) => b.conf - a.conf);
    trimmedOcr.push(...arr.slice(0, ocrTopN));
  }

  // AX: prefer focused-window display subtree.
  const focusedDisplay = scene.focused_window?.displayId ?? scene.displays[0]?.id ?? 0;
  const focusedAx = scene.ax.filter((n) => n.displayId === focusedDisplay);
  const remaining = scene.ax.filter((n) => n.displayId !== focusedDisplay);
  const trimmedAx = [...focusedAx, ...remaining].slice(0, axMax);

  // Prefer apps with visible windows — those are the ones the planner can
  // act on. Background-only processes get clipped to keep the prompt
  // tractable on Linux hosts with 500+ processes.
  const appsByPriority = [...scene.apps].sort((a, b) => {
    const aw = a.windows.length;
    const bw = b.windows.length;
    if (aw !== bw) return bw - aw;
    return a.name.localeCompare(b.name);
  });
  const trimmedApps = appsByPriority.slice(0, appMax);
  const compactApps = trimmedApps.map((app) => ({
    name: app.name,
    pid: app.pid,
    window_count: app.windows.length,
    windows: app.windows.slice(0, appTopWindows).map((w) => ({
      id: w.id,
      title: w.title,
      displayId: w.displayId,
    })),
  }));

  const compact = {
    timestamp: scene.timestamp,
    displays: scene.displays.map((d) => ({
      id: d.id,
      name: d.name,
      bounds: d.bounds,
      primary: d.primary,
      scaleFactor: d.scaleFactor,
    })),
    focused_window: scene.focused_window,
    apps: compactApps,
    ocr: trimmedOcr.map((b) => ({
      id: b.id,
      text: b.text,
      bbox: b.bbox,
      conf: Number(b.conf.toFixed(3)),
      displayId: b.displayId,
    })),
    ax: trimmedAx.map((n) => ({
      id: n.id,
      role: n.role,
      label: n.label,
      bbox: n.bbox,
      actions: n.actions,
      displayId: n.displayId,
    })),
    vlm_scene: scene.vlm_scene,
    vlm_elements: scene.vlm_elements,
    truncation: {
      ocr_total: scene.ocr.length,
      ocr_kept: trimmedOcr.length,
      ax_total: scene.ax.length,
      ax_kept: trimmedAx.length,
      apps_total: scene.apps.length,
      apps_kept: trimmedApps.length,
    },
  };
  return ["```json", JSON.stringify(compact, null, 2), "```"].join("\n");
}
