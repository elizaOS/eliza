/**
 * Lossless Scene serializer.
 *
 * Used by the `scene` provider to render the current Scene into the agent
 * prompt. Every detected app, window, OCR block, and accessibility node is
 * retained so the model never reasons from a partial scene.
 *
 * The output is fenced JSON for predictable downstream tokenization.
 */

import type { Scene } from "./scene-types.js";

export interface SerializeOptions {
  /** @deprecated Scene serialization is lossless; this option is ignored. */
  ocrTopN?: number;
  /** @deprecated Scene serialization is lossless; this option is ignored. */
  axMax?: number;
  /** @deprecated Scene serialization is lossless; this option is ignored. */
  appTopWindows?: number;
  /** @deprecated Scene serialization is lossless; this option is ignored. */
  appMax?: number;
}

export function serializeSceneForPrompt(
  scene: Scene,
  options: SerializeOptions = {},
): string {
  void options;

  // OCR remains complete; confidence ordering only improves readability.
  const ocrByDisplay = new Map<number, typeof scene.ocr>();
  for (const box of scene.ocr) {
    const arr = ocrByDisplay.get(box.displayId) ?? [];
    arr.push(box);
    ocrByDisplay.set(box.displayId, arr);
  }
  const completeOcr: typeof scene.ocr = [];
  for (const [, arr] of ocrByDisplay) {
    arr.sort((a, b) => b.conf - a.conf);
    completeOcr.push(...arr);
  }

  // AX: prefer focused-window display subtree.
  const focusedDisplay =
    scene.focused_window?.displayId ?? scene.displays[0]?.id ?? 0;
  const focusedAx = scene.ax.filter((n) => n.displayId === focusedDisplay);
  const remaining = scene.ax.filter((n) => n.displayId !== focusedDisplay);
  const completeAx = [...focusedAx, ...remaining];

  // Prefer apps with visible windows while retaining every app and window.
  const appsByPriority = [...scene.apps].sort((a, b) => {
    const aw = a.windows.length;
    const bw = b.windows.length;
    if (aw !== bw) return bw - aw;
    return a.name.localeCompare(b.name);
  });
  const compactApps = appsByPriority.map((app) => ({
    name: app.name,
    pid: app.pid,
    window_count: app.windows.length,
    windows: app.windows.map((w) => ({
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
    ocr: completeOcr.map((b) => ({
      id: b.id,
      text: b.text,
      bbox: b.bbox,
      conf: Number(b.conf.toFixed(3)),
      displayId: b.displayId,
    })),
    ax: completeAx.map((n) => ({
      id: n.id,
      role: n.role,
      label: n.label,
      bbox: n.bbox,
      actions: n.actions,
      displayId: n.displayId,
    })),
    vlm_scene: scene.vlm_scene,
    vlm_elements: scene.vlm_elements,
  };
  return ["```json", JSON.stringify(compact, null, 2), "```"].join("\n");
}
