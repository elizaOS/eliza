/** Explicit physical-pointer fallback with restoration and interference guard. */

import type { CursorPoint } from "./macos-accessibility-actions.js";

export interface RestoredPointerFallbackInput {
  operation: () => Promise<void>;
  readCursor: () => Promise<CursorPoint>;
  restoreCursor: (point: CursorPoint) => Promise<void>;
  /** Expected physical path, including the destination. */
  expectedPath: CursorPoint[];
  sampleIntervalMs?: number;
  tolerancePx?: number;
}

export interface RestoredPointerFallbackResult {
  restoredTo: CursorPoint;
  pointerBorrowed: true;
}

function pointSegmentDistance(
  point: CursorPoint,
  start: CursorPoint,
  end: CursorPoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0)
    return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) /
        (dx * dx + dy * dy),
    ),
  );
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function pathDistance(point: CursorPoint, path: CursorPoint[]): number {
  if (path.length === 0) return Number.POSITIVE_INFINITY;
  if (path.length === 1)
    return Math.hypot(point.x - path[0].x, point.y - path[0].y);
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < path.length; index += 1) {
    minimum = Math.min(
      minimum,
      pointSegmentDistance(point, path[index - 1], path[index]),
    );
  }
  return minimum;
}

export async function runRestoredPointerFallback(
  input: RestoredPointerFallbackInput,
): Promise<RestoredPointerFallbackResult> {
  const original = await input.readCursor();
  const expectedPath = [original, ...input.expectedPath];
  const tolerance = Math.max(2, input.tolerancePx ?? 20);
  let interference = false;
  let sampling = false;
  const interval = setInterval(
    () => {
      if (sampling || interference) return;
      sampling = true;
      void input
        .readCursor()
        .then((cursor) => {
          if (pathDistance(cursor, expectedPath) > tolerance)
            interference = true;
        })
        .catch(() => {
          interference = true;
        })
        .finally(() => {
          sampling = false;
        });
    },
    Math.max(8, input.sampleIntervalMs ?? 20),
  );

  try {
    await input.operation();
  } finally {
    clearInterval(interval);
  }

  const finalCursor = await input.readCursor();
  const expectedFinal = expectedPath.at(-1) ?? original;
  if (pathDistance(finalCursor, [expectedFinal]) > tolerance || interference) {
    // The user's movement is authoritative. Do not warp it back over them.
    throw new Error(
      "USER_INPUT_INTERFERENCE: physical pointer moved outside the leased fallback path",
    );
  }

  await input.restoreCursor(original);
  const restored = await input.readCursor();
  if (pathDistance(restored, [original]) > 2) {
    throw new Error("POINTER_RESTORE_FAILED");
  }
  return { restoredTo: original, pointerBorrowed: true };
}
