/**
 * WS8 — Normalize Android accessibility-tree output into the WS6 `Scene.ax`
 * shape that the WS7 cascade consumes.
 *
 * The Kotlin side (`MiladyAccessibilityService.getAccessibilityTreeJson()`)
 * emits JSON with this shape per node:
 *
 *   { id: string, role: string, label: string|null,
 *     bbox: { x, y, w, h },
 *     actions: string[] }
 *
 * WS6's `SceneAxNode` (see `scene/scene-types.ts`) is:
 *
 *   { id: string, role: string, label?: string,
 *     bbox: [x, y, w, h],
 *     actions: string[], displayId: number }
 *
 * The only real differences are bbox object↔tuple and the addition of a
 * `displayId` (Android phones always run as a single logical display from the
 * scene-builder's perspective; multi-display Android is out of scope).
 *
 * `androidAxIdToSceneId(id, displayId)` rewrites the Kotlin-side integer id
 * into the cascade's stable `a<displayId>-<seq>` form so `resolveReference`
 * picks it up exactly like a desktop AX node.
 */

import type { SceneAxNode } from "../scene/scene-types.js";
import type { AndroidAxNode } from "./android-bridge.js";

/** Stable scene-ax id for an Android node. Matches the desktop format. */
export function androidAxIdToSceneId(rawId: string, displayId: number): string {
  return `a${displayId}-${rawId}`;
}

/**
 * Parse the JSON payload emitted by `MiladyAccessibilityService.getAccessibilityTreeJson()`
 * and normalize it into `SceneAxNode[]`. Invalid entries are dropped, not
 * thrown — the cascade prefers a partial tree to an unrecoverable error
 * when (e.g.) one rogue node is missing a field.
 *
 * Throws only when the top-level payload is not a JSON array. The Kotlin
 * side guarantees array output (or `"[]"` on internal failure) so this is
 * a planner-side contract check.
 */
export function parseAndroidAxTree(
  nodesJson: string,
  displayId: number,
): SceneAxNode[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(nodesJson);
  } catch (err) {
    throw new Error(
      `[computeruse/android] AX tree JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `[computeruse/android] AX tree JSON must be an array; got ${typeof parsed}`,
    );
  }
  const out: SceneAxNode[] = [];
  for (const item of parsed) {
    const node = normalizeAndroidAxNode(item, displayId);
    if (node) out.push(node);
  }
  return out;
}

/**
 * Normalize a single AndroidAxNode-shaped value into SceneAxNode. Returns
 * null when the value is missing required fields — the caller decides
 * whether to surface the partial parse.
 */
export function normalizeAndroidAxNode(
  raw: unknown,
  displayId: number,
): SceneAxNode | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  const role = typeof r.role === "string" ? r.role : null;
  if (!id || !role) return null;
  const label =
    typeof r.label === "string"
      ? r.label
      : r.label === null
        ? undefined
        : undefined;
  const bbox = r.bbox;
  if (!bbox || typeof bbox !== "object") return null;
  const bb = bbox as Record<string, unknown>;
  const x = numberOrNull(bb.x);
  const y = numberOrNull(bb.y);
  const w = numberOrNull(bb.w);
  const h = numberOrNull(bb.h);
  if (x === null || y === null || w === null || h === null) return null;
  const actionsRaw = Array.isArray(r.actions) ? r.actions : [];
  const actions = actionsRaw.filter((a): a is string => typeof a === "string");
  const node: SceneAxNode = {
    id: androidAxIdToSceneId(id, displayId),
    role,
    bbox: [x, y, w, h],
    actions,
    displayId,
  };
  if (label !== undefined) node.label = label;
  return node;
}

/**
 * Inverse helper — produce a Kotlin-shaped `AndroidAxNode` from a `SceneAxNode`.
 * Primarily for tests and trajectory replay.
 */
export function sceneAxToAndroidAxNode(node: SceneAxNode): AndroidAxNode {
  const [x, y, w, h] = node.bbox;
  const idPrefix = `a${node.displayId}-`;
  const rawId = node.id.startsWith(idPrefix)
    ? node.id.slice(idPrefix.length)
    : node.id;
  return {
    id: rawId,
    role: node.role,
    label: node.label ?? null,
    bbox: { x, y, w, h },
    actions: node.actions,
  };
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
