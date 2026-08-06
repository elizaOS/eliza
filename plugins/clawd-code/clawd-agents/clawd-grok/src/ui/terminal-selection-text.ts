import type { Renderable } from "@opentui/core";
import { TextBufferRenderable } from "@opentui/core";

/** Subset of OpenTUI Selection used for clipboard (avoid private package subpaths). */
export type TuiSelectionSnapshot = {
  selectedRenderables: Renderable[];
  bounds: { x: number; y: number; width: number; height: number };
  anchor: { x: number; y: number };
  getSelectedText(): string;
};

function isStrictDescendantOf(ancestor: Renderable, node: Renderable): boolean {
  let p: Renderable | null = node.parent as Renderable | null;
  while (p) {
    if (p === ancestor) return true;
    p = p.parent as Renderable | null;
  }
  return false;
}

/** Drop parents when a deeper selected renderable is nested under them (duplicate coverage). */
function selectedTextBuffersOnly(selection: TuiSelectionSnapshot): TextBufferRenderable[] {
  const raw = selection.selectedRenderables.filter(
    (r): r is TextBufferRenderable => !r.isDestroyed && r instanceof TextBufferRenderable,
  );
  return raw.filter((r) => !raw.some((other) => other !== r && isStrictDescendantOf(r, other)));
}

function sortReadingOrder(a: TextBufferRenderable, b: TextBufferRenderable): number {
  if (a.y !== b.y) return a.y - b.y;
  return a.x - b.x;
}

/**
 * OpenTUI's Selection.getSelectedText() concatenates every intersected text buffer. In markdown-heavy
 * UIs a tiny drag can still hit dozens/hundreds of sibling line renderables. We narrow to leaf buffers,
 * optionally to the selection midpoint for thin rects, and fall back to the anchor cell's smallest buffer
 * when the joined text is still huge.
 */
export function getCompactTuiSelectionText(selection: TuiSelectionSnapshot): string {
  let buffers = selectedTextBuffersOnly(selection);
  if (buffers.length === 0) return selection.getSelectedText();

  const b = selection.bounds;
  const thin = b.height <= 2;
  if (thin && buffers.length > 6) {
    const midX = Math.floor(b.x + b.width / 2);
    const midY = Math.floor(b.y + b.height / 2);
    const narrowed = buffers.filter((r) => midX >= r.x && midX < r.x + r.width && midY >= r.y && midY < r.y + r.height);
    if (narrowed.length > 0) buffers = narrowed;
  }

  buffers = [...buffers].sort(sortReadingOrder);
  let text = buffers
    .map((r) => r.getSelectedText())
    .filter((t) => t.length > 0)
    .join("\n");

  const lineCount = text === "" ? 0 : text.split("\n").length;
  if (lineCount > 40 && thin) {
    const ax = selection.anchor.x;
    const ay = selection.anchor.y;
    const atPoint = buffers.filter((r) => ax >= r.x && ax < r.x + r.width && ay >= r.y && ay < r.y + r.height);
    if (atPoint.length > 0) {
      atPoint.sort((a, b) => a.width * a.height - b.width * b.height);
      const fallback = atPoint[0].getSelectedText();
      if (fallback && fallback.split("\n").length < lineCount) text = fallback;
    }
  }

  return text || selection.getSelectedText();
}
