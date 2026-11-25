// spec/files/scan/searchablePdf.md, "Story: Save the reviewed text beside the image of its own page"
import { Effect } from "effect";
import { createScanPdf, type ScanPdfMetadata } from "../src/documents/scan-pdf.vibe";
import type { ScanTextLine } from "../src/documents/scan-text-layer.vibe";

interface Document {
  readonly metadata: ScanPdfMetadata;
  readonly images: readonly Blob[];
  readonly text: readonly (readonly ScanTextLine[])[];
}

self.addEventListener("message", ({ data }: MessageEvent<Document>) => {
  void Effect.runPromise(Effect.match(createScanPdf(data.metadata, data.images, data.text), {
    onFailure: (error) => ({ ok: false, reason: error.reason } as const),
    onSuccess: (bytes) => ({ ok: true, bytes } as const),
  })).then((reply) => self.postMessage(reply));
});
