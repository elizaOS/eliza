export type ScanCorner = { x: number; y: number };
export type ScanCorners = [ScanCorner, ScanCorner, ScanCorner, ScanCorner];
export const fullPageCorners = (): ScanCorners => [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
/** Clockwise normalized corners, starting at the top left. Reject folds and tiny regions. */
export function validateScanCorners(corners: ScanCorners) {
  if (
    !Array.isArray(corners) ||
    corners.length !== 4 ||
    corners.some(
      (p) =>
        !p ||
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        p.x < 0 ||
        p.x > 1 ||
        p.y < 0 ||
        p.y > 1,
    )
  )
    throw Error("Keep all four corners inside the image.");
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i],
      b = corners[(i + 1) % 4],
      c = corners[(i + 2) % 4];
    area += a.x * b.y - b.x * a.y;
    if (
      (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0.0001 ||
      Math.hypot(b.x - a.x, b.y - a.y) < 0.02
    )
      throw Error(
        "Keep corners in clockwise order without crossing the page edges.",
      );
  }
  if (area < 0.02) throw Error("Select a larger page area.");
}
export async function correctScanPage(
  image: Blob,
  input: ScanCorners,
  signal: AbortSignal,
): Promise<Blob> {
  const corners = input.map((p) => ({ ...p })) as ScanCorners;
  signal.throwIfAborted();
  validateScanCorners(corners);
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(image.type) ||
    !image.size ||
    image.size > 16 * 1024 * 1024
  )
    throw Error("Choose an image up to 16 MB.");
  const bitmap = await createImageBitmap(image);
  const source = document.createElement("canvas");
  try {
    signal.throwIfAborted();
    if (
      !bitmap.width ||
      !bitmap.height ||
      bitmap.width * bitmap.height > 32000000
    )
      throw Error("Image dimensions are too large.");
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    source.width = Math.max(2, Math.round(bitmap.width * scale));
    source.height = Math.max(2, Math.round(bitmap.height * scale));
    const ctx = source.getContext("2d");
    if (!ctx) throw Error("Image correction is unavailable.");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, source.width, source.height);
    ctx.drawImage(bitmap, 0, 0, source.width, source.height);
  } finally {
    bitmap.close();
  }
  const points = corners.map((p) => ({
    x: p.x * (source.width - 1),
    y: p.y * (source.height - 1),
  }));
  const [p0, p1, p2, p3] = points;
  const distance = (a: ScanCorner, b: ScanCorner) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  const rawWidth = (distance(p0, p1) + distance(p3, p2)) / 2,
    rawHeight = (distance(p0, p3) + distance(p1, p2)) / 2,
    scale = Math.min(1, 2048 / Math.max(rawWidth, rawHeight));
  const output = document.createElement("canvas");
  output.width = Math.max(2, Math.round(rawWidth * scale));
  output.height = Math.max(2, Math.round(rawHeight * scale));
  const ctx = output.getContext("2d");
  if (!ctx) throw Error("Image correction is unavailable.");
  const dx1 = p1.x - p2.x,
    dx2 = p3.x - p2.x,
    dx3 = p0.x - p1.x + p2.x - p3.x,
    dy1 = p1.y - p2.y,
    dy2 = p3.y - p2.y,
    dy3 = p0.y - p1.y + p2.y - p3.y,
    det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det,
    h = (dx1 * dy3 - dx3 * dy1) / det,
    a = p1.x - p0.x + g * p1.x,
    b = p3.x - p0.x + h * p3.x,
    d = p1.y - p0.y + g * p1.y,
    e = p3.y - p0.y + h * p3.y;
  const sourceContext = source.getContext("2d");
  if (!sourceContext) throw Error("Image processing is unavailable.");
  const pixels = sourceContext.getImageData(
      0,
      0,
      source.width,
      source.height,
    ).data,
    result = ctx.createImageData(output.width, output.height);
  for (let y = 0; y < output.height; y++) {
    if (y % 32 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
    }
    for (let x = 0; x < output.width; x++) {
      const u = x / (output.width - 1),
        v = y / (output.height - 1),
        den = g * u + h * v + 1;
      const sx = Math.max(
          0,
          Math.min(source.width - 1, (a * u + b * v + p0.x) / den),
        ),
        sy = Math.max(
          0,
          Math.min(source.height - 1, (d * u + e * v + p0.y) / den),
        );
      const left = Math.floor(sx),
        top = Math.floor(sy),
        right = Math.min(left + 1, source.width - 1),
        bottom = Math.min(top + 1, source.height - 1),
        fx = sx - left,
        fy = sy - top,
        at = (y * output.width + x) * 4;
      for (let c = 0; c < 3; c++)
        result.data[at + c] =
          (pixels[(top * source.width + left) * 4 + c] * (1 - fx) +
            pixels[(top * source.width + right) * 4 + c] * fx) *
            (1 - fy) +
          (pixels[(bottom * source.width + left) * 4 + c] * (1 - fx) +
            pixels[(bottom * source.width + right) * 4 + c] * fx) *
            fy;
      result.data[at + 3] = 255;
    }
  }
  signal.throwIfAborted();
  ctx.putImageData(result, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) =>
    output.toBlob(
      (value) =>
        value
          ? resolve(value)
          : reject(Error("Could not encode the corrected page.")),
      "image/jpeg",
      0.92,
    ),
  );
  signal.throwIfAborted();
  return blob;
}
