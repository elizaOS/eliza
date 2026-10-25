import { type ScanTextLine, validateScanTextLayer } from "./scan-text-layer.ts";
export interface ScanPdfMetadata {
  title: string;
  creator: string;
}
/** Images remain unchanged; optional reviewed line layers are invisible searchable text. */
export async function createScanPdf(
  metadata: ScanPdfMetadata,
  input: Blob | Blob[],
  signal: AbortSignal,
  textLayers?: ScanTextLine[][],
): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted();
  const images = Array.isArray(input) ? [...input] : [input];
  if (
    !images.length ||
    images.length > 20 ||
    images.reduce((total, image) => total + image.size, 0) > 64 * 1024 * 1024
  )
    throw Error("Choose 1 to 20 pages, up to 64 MB total.");
  const layers = textLayers?.map((lines) => {
    validateScanTextLayer(lines);
    return lines.map((line) => ({ ...line }));
  });
  if (layers && layers.length !== images.length)
    throw Error("Text review must match every document page.");
  const {
    PDFDocument,
    StandardFonts,
    pushGraphicsState,
    popGraphicsState,
    setTextRenderingMode,
    TextRenderingMode,
    setCharacterSqueeze,
  } = await import("pdf-lib");
  signal.throwIfAborted();
  const pdf = await PDFDocument.create();
  const font = layers
    ? await pdf.embedFont(StandardFonts.Helvetica)
    : undefined;
  if (font && layers)
    for (const lines of layers)
      for (const line of lines) {
        try {
          font.encodeText(line.text);
        } catch {
          throw Error(
            "Searchable PDF supports English and Western European text. Correct unsupported characters or export an image-only PDF.",
          );
        }
      }
  for (const [index, image] of images.entries()) {
    signal.throwIfAborted();
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(image.type) ||
      !image.size ||
      image.size > 16 * 1024 * 1024
    )
      throw Error("Choose a supported image up to 16 MB.");
    const bitmap = await createImageBitmap(image);
    let jpeg: Blob;
    try {
      signal.throwIfAborted();
      if (
        !bitmap.width ||
        !bitmap.height ||
        bitmap.width * bitmap.height > 32000000
      )
        throw Error("Image dimensions are too large.");
      const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw Error("Image conversion is unavailable.");
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      jpeg = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(Error("Image conversion failed.")),
          "image/jpeg",
          0.9,
        ),
      );
    } finally {
      bitmap.close();
    }
    signal.throwIfAborted();
    const picture = await pdf.embedJpg(await jpeg.arrayBuffer());
    signal.throwIfAborted();
    const landscape = picture.width > picture.height;
    const page = pdf.addPage(landscape ? [841.89, 595.28] : [595.28, 841.89]);
    const margin = 24;
    const scale = Math.min(
      (page.getWidth() - margin * 2) / picture.width,
      (page.getHeight() - margin * 2) / picture.height,
    );
    const width = picture.width * scale,
      height = picture.height * scale;
    page.drawImage(picture, {
      x: (page.getWidth() - width) / 2,
      y: (page.getHeight() - height) / 2,
      width,
      height,
    });
    if (font && layers)
      for (const line of layers[index]) {
        signal.throwIfAborted();
        if (!line.text.trim()) continue;
        const size =
            (line.height * height) / font.heightAtSize(1, { descender: false }),
          natural = font.widthOfTextAtSize(line.text, size);
        if (!natural) continue;
        page.pushOperators(
          pushGraphicsState(),
          setTextRenderingMode(TextRenderingMode.Invisible),
          setCharacterSqueeze(((line.width * width) / natural) * 100),
        );
        page.drawText(line.text, {
          font,
          size,
          x: (page.getWidth() - width) / 2 + line.x * width,
          y:
            (page.getHeight() - height) / 2 +
            (1 - line.y - line.height) * height,
        });
        page.pushOperators(popGraphicsState());
      }
  }
  pdf.setTitle(metadata.title);
  pdf.setCreator(metadata.creator);
  const bytes = new Uint8Array(await pdf.save());
  signal.throwIfAborted();
  if (bytes.length > 8 * 1024 * 1024)
    throw Error("PDF exceeds the 8 MB export limit.");
  return bytes;
}
