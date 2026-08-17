/**
 * unpdf — Cloudflare Workers bundle shim.
 *
 * `@elizaos/core`'s document feature reaches unpdf through `await import()`,
 * which keeps it off the Node startup path but does not keep it out of this
 * Worker bundle: Wrangler bundles core from source (see this package's
 * `tsconfig.json` alias for `@elizaos/core/edge`) and inlines the whole PDF
 * toolchain — ~70 pdfjs modules — into the deployed artifact. Document
 * extraction does not run on the Worker (the agent runtime lives on the
 * sidecar, and `documents` is `false` in core's `nativeRuntimeFeatureDefaults`),
 * so the parser is stubbed at bundle time. Any code path that actually calls it
 * throws a clear error instead of silently returning empty text (#21327).
 */

const NOT_AVAILABLE =
  "unpdf is not available on Cloudflare Workers — PDF text extraction runs on the Node sidecar (cloud/INFRA.md).";

export function extractText(): never {
  throw new Error(NOT_AVAILABLE);
}

export function getDocumentProxy(): never {
  throw new Error(NOT_AVAILABLE);
}

export function definePDFJSModule(): never {
  throw new Error(NOT_AVAILABLE);
}

export function getResolvedPDFJS(): never {
  throw new Error(NOT_AVAILABLE);
}

export function extractImages(): never {
  throw new Error(NOT_AVAILABLE);
}

export function renderPageAsImage(): never {
  throw new Error(NOT_AVAILABLE);
}

export function getMeta(): never {
  throw new Error(NOT_AVAILABLE);
}

const workerUnpdfSurface = {
  definePDFJSModule,
  extractImages,
  extractText,
  getDocumentProxy,
  getMeta,
  getResolvedPDFJS,
  renderPageAsImage,
};
export default workerUnpdfSurface;
