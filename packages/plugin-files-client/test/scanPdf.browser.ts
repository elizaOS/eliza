// spec/files/scan/searchablePdf.md, "Story: Save the reviewed text beside the image of its own page"
import type { ScanTextLine } from "../src/documents/scan-text-layer.vibe";

type PdfReply = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: string };

export async function workerPdf(images: readonly Blob[], text: readonly (readonly ScanTextLine[])[], signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const worker = new Worker(new URL("./scanPdf.worker.ts", import.meta.url), { type: "module" });
  const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
  const aborted = () => reject(signal.reason);
  signal.addEventListener("abort", aborted, { once: true });
  worker.onmessage = ({ data }: MessageEvent<PdfReply>) => {
    if (data.ok) resolve(data.bytes);
    else reject(new Error(data.reason));
  };
  worker.onerror = () => reject(new Error("Scan PDF worker stopped"));
  try {
    worker.postMessage({ metadata: { title: "Scan", creator: "Files" }, images, text });
    return await promise;
  } finally {
    signal.removeEventListener("abort", aborted);
    worker.terminate();
  }
}

export async function cancelledPdf(images: readonly Blob[], text: readonly (readonly ScanTextLine[])[]): Promise<boolean> {
  const controller = new AbortController();
  const result = workerPdf(images, text, controller.signal);
  controller.abort();
  try {
    await result;
    return false;
  } catch (cause) {
    return cause === controller.signal.reason;
  }
}
