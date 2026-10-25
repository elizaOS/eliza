interface WorkerResult {
  text: string;
  confidence: number;
  blocks:
    | {
        paragraphs?: {
          lines?: {
            text: string;
            bbox: { x0: number; y0: number; x1: number; y1: number };
          }[];
        }[];
      }[]
    | null;
}

export interface OcrConfig {
  workerUrl: string;
  assetsUrl: string;
  language: string;
}

import { type ScanTextLine, validateScanTextLayer } from "./scan-text-layer.ts";
export type OcrResult = {
  text: string;
  confidence: number;
  lines?: ScanTextLine[];
};
export type OcrProgress = { status: string; progress: number };

/** Pinned Tesseract 7 worker protocol. Owning the Worker before initialization
 * makes cancellation terminate model startup as well as active recognition. */
export async function recognizeLocalText(
  config: OcrConfig,
  image: Blob,
  signal: AbortSignal,
  onProgress: (value: OcrProgress) => void = () => {},
  layout = false,
): Promise<OcrResult> {
  signal.throwIfAborted();
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(image.type) ||
    image.size === 0 ||
    image.size > 16 * 1024 * 1024
  )
    throw Error("Choose a JPEG, PNG or WebP image up to 16 MB.");
  const worker = new Worker(new URL(config.workerUrl, location.href));
  const workerId = crypto.randomUUID();
  let sequence = 0,
    ended = false;
  let pending:
    | {
        id: string;
        action: string;
        resolve: (value: WorkerResult) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  const finish = (error: Error) => {
    if (ended) return;
    ended = true;
    worker.terminate();
    pending?.reject(error);
    pending = undefined;
  };
  const aborted = () =>
    finish(new DOMException("Scan cancelled", "AbortError"));
  signal.addEventListener("abort", aborted, { once: true });
  worker.onerror = () =>
    finish(Error("The local scan engine could not start."));
  worker.onmessageerror = () =>
    finish(Error("The local scan engine returned unreadable data."));
  worker.onmessage = (event) => {
    const value = event.data,
      job = pending;
    if (
      ended ||
      !job ||
      value?.workerId !== workerId ||
      value.jobId !== job.id ||
      value.action !== job.action
    )
      return;
    if (value.status === "progress") {
      if (
        typeof value.data?.status === "string" &&
        Number.isFinite(value.data.progress)
      )
        onProgress({
          status: value.data.status,
          progress: Math.max(0, Math.min(1, value.data.progress)),
        });
    } else if (value.status === "resolve") {
      pending = undefined;
      job.resolve(value.data);
    } else if (value.status === "reject") {
      pending = undefined;
      job.reject(
        Error("The image could not be read by the local scan engine."),
      );
    }
  };
  const request = (action: string, payload: unknown) =>
    new Promise<WorkerResult>((resolve, reject) => {
      if (ended) {
        reject(new DOMException("Scan cancelled", "AbortError"));
        return;
      }
      const id = String(++sequence);
      pending = { id, action, resolve, reject };
      try {
        worker.postMessage({ workerId, jobId: id, action, payload });
      } catch {
        finish(Error("The scan request could not start."));
      }
    });
  try {
    const bitmap = await createImageBitmap(image);
    let bounded: Blob,
      width = 0,
      height = 0;
    try {
      signal.throwIfAborted();
      if (
        !bitmap.width ||
        !bitmap.height ||
        bitmap.width * bitmap.height > 32000000
      )
        throw Error("Choose an image with at most 32 million pixels.");
      const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      width = canvas.width;
      height = canvas.height;
      const context = canvas.getContext("2d");
      if (!context) throw Error("Image processing is unavailable.");
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bounded = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(Error("Image conversion failed.")),
          "image/png",
        ),
      );
    } finally {
      bitmap.close();
    }
    const bytes = new Uint8Array(await bounded.arrayBuffer());
    signal.throwIfAborted();
    const local = new URL(config.assetsUrl, location.href).href;
    await request("load", {
      options: { lstmOnly: true, corePath: local, logging: false },
    });
    await request("loadLanguage", {
      langs: [config.language],
      options: {
        langPath: local,
        cacheMethod: "none",
        gzip: true,
        lstmOnly: true,
      },
    });
    await request("initialize", { langs: config.language, oem: 1, config: {} });
    const result = await request("recognize", {
      image: bytes,
      options: {},
      output: { text: true, blocks: layout },
    });
    if (
      typeof result?.text !== "string" ||
      !Number.isFinite(result.confidence) ||
      result.text.length > 100000
    )
      throw Error("The scan result is invalid or too large.");
    let lines: ScanTextLine[] | undefined;
    if (layout) {
      if (result.blocks !== null && !Array.isArray(result.blocks))
        throw Error("The scan engine did not return text positions.");
      lines = [];
      for (const block of result.blocks ?? [])
        for (const paragraph of block.paragraphs ?? [])
          for (const line of paragraph.lines ?? []) {
            if (typeof line.text !== "string" || !line.bbox)
              throw Error("Invalid scanned text position.");
            const box = line.bbox;
            lines.push({
              text: line.text.trim(),
              x: box.x0 / width,
              y: box.y0 / height,
              width: (box.x1 - box.x0) / width,
              height: (box.y1 - box.y0) / height,
            });
            if (lines.length > 2000) throw Error("Too many scanned lines.");
          }
      validateScanTextLayer(lines);
    }
    return { text: result.text.trim(), confidence: result.confidence, lines };
  } finally {
    signal.removeEventListener("abort", aborted);
    finish(new DOMException("Scan finished", "AbortError"));
  }
}
