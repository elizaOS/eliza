import {
  type ScanCorner,
  type ScanCorners,
  validateScanCorners,
} from "./scan-correction.ts";

const cross = (a: ScanCorner, b: ScanCorner, c: ScanCorner) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const area = (p: ScanCorner[]) =>
  Math.abs(
    p.reduce((s, a, i) => {
      const b = p[(i + 1) % p.length];
      return s + a.x * b.y - b.x * a.y;
    }, 0),
  ) / 2;
function hull(points: ScanCorner[]) {
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: ScanCorner[] = [],
    upper: ScanCorner[] = [];
  for (const p of points) {
    while (
      lower.length > 1 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    )
      lower.pop();
    lower.push(p);
  }
  for (const p of [...points].reverse()) {
    while (
      upper.length > 1 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    )
      upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
/** Conservative local contrast segmentation. A suggestion is never an applied crop. */
export async function detectScanEdges(
  image: Blob,
  signal: AbortSignal,
): Promise<ScanCorners | undefined> {
  signal.throwIfAborted();
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(image.type) ||
    !image.size ||
    image.size > 16 * 1024 * 1024
  )
    throw Error("Choose an image up to 16 MB.");
  const bitmap = await createImageBitmap(image),
    canvas = document.createElement("canvas");
  let pixels: Uint8ClampedArray;
  try {
    signal.throwIfAborted();
    if (
      !bitmap.width ||
      !bitmap.height ||
      bitmap.width * bitmap.height > 32000000
    )
      throw Error("Image dimensions are too large.");
    const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(2, Math.round(bitmap.width * scale));
    canvas.height = Math.max(2, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw Error("Page detection is unavailable.");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } finally {
    bitmap.close();
  }
  const w = canvas.width,
    h = canvas.height,
    n = w * h,
    gray = new Uint8Array(n),
    border: number[] = [];
  for (let i = 0; i < n; i++) {
    gray[i] = Math.round(
      0.2126 * pixels[i * 4] +
        0.7152 * pixels[i * 4 + 1] +
        0.0722 * pixels[i * 4 + 2],
    );
    if (i < w || i >= n - w || i % w === 0 || i % w === w - 1)
      border.push(gray[i]);
  }
  border.sort((a, b) => a - b);
  const background = border[Math.floor(border.length / 2)];
  const candidates: { corners: ScanCorners; size: number }[] = [];
  for (const direction of [1, -1]) {
    const seen = new Uint8Array(n),
      queue = new Int32Array(n);
    for (let start = 0; start < n; start++) {
      if (start % 2048 === 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
        signal.throwIfAborted();
      }
      if (seen[start] || direction * (gray[start] - background) < 30) continue;
      let head = 0,
        tail = 1,
        touches = false;
      queue[0] = start;
      seen[start] = 1;
      const points: ScanCorner[] = [];
      while (head < tail) {
        const at = queue[head++],
          x = at % w,
          y = Math.floor(at / w);
        if (x === 0 || x === w - 1 || y === 0 || y === h - 1) touches = true;
        let edge = false;
        for (const next of [
          x ? at - 1 : -1,
          x < w - 1 ? at + 1 : -1,
          y ? at - w : -1,
          y < h - 1 ? at + w : -1,
        ]) {
          if (next < 0 || direction * (gray[next] - background) < 30) {
            edge = true;
            continue;
          }
          if (!seen[next]) {
            seen[next] = 1;
            queue[tail++] = next;
          }
        }
        if (edge) points.push({ x, y });
      }
      if (touches || tail < n * 0.15) continue;
      const outline = hull(points),
        fullArea = area(outline);
      if (fullArea <= 0 || tail / fullArea < 0.7) continue;
      while (outline.length > 4) {
        let smallest = Infinity,
          index = 0;
        for (let i = 0; i < outline.length; i++) {
          const loss = Math.abs(
            cross(
              outline[(i + outline.length - 1) % outline.length],
              outline[i],
              outline[(i + 1) % outline.length],
            ),
          );
          if (loss < smallest) {
            smallest = loss;
            index = i;
          }
        }
        outline.splice(index, 1);
      }
      if (outline.length !== 4 || area(outline) / fullArea < 0.9) continue;
      let first = 0;
      for (let i = 1; i < 4; i++)
        if (outline[i].x + outline[i].y < outline[first].x + outline[first].y)
          first = i;
      const corners = [...outline.slice(first), ...outline.slice(0, first)].map(
        (p) => ({ x: p.x / (w - 1), y: p.y / (h - 1) }),
      ) as ScanCorners;
      try {
        validateScanCorners(corners);
        candidates.push({ corners, size: tail });
      } catch {
        /* Retain manual controls for non-quadrilateral regions. */
      }
    }
  }
  signal.throwIfAborted();
  candidates.sort((a, b) => b.size - a.size);
  if (!candidates.length || candidates[1]?.size > candidates[0].size * 0.5)
    return undefined;
  return candidates[0].corners;
}
