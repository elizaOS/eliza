/**
 * mammoth — Cloudflare Workers bundle shim.
 *
 * mammoth is a CJS DOCX parser whose module graph does `require("fs")` at load
 * (`lib/unzip.js`) and drags jszip/pako/bluebird/dingbat-to-unicode with it.
 * `@elizaos/core` loads it through `await import()`, but Wrangler bundles core
 * from source (see this package's `tsconfig.json` alias for
 * `@elizaos/core/edge`), so the whole docx toolchain lands in the deployed
 * Worker. DOCX extraction does not run here — the agent runtime lives on the
 * sidecar and `documents` is `false` in core's `nativeRuntimeFeatureDefaults` —
 * so it is stubbed at bundle time and any real call throws a clear error rather
 * than returning empty text (#21327).
 */

const NOT_AVAILABLE =
  "mammoth is not available on Cloudflare Workers — DOCX text extraction runs on the Node sidecar (cloud/INFRA.md).";

export function extractRawText(): never {
  throw new Error(NOT_AVAILABLE);
}

export function convertToHtml(): never {
  throw new Error(NOT_AVAILABLE);
}

export function convertToMarkdown(): never {
  throw new Error(NOT_AVAILABLE);
}

export function embedStyleMap(): never {
  throw new Error(NOT_AVAILABLE);
}

export const images = new Proxy(
  {},
  {
    get() {
      throw new Error(NOT_AVAILABLE);
    },
  },
);

const workerMammothSurface = {
  convertToHtml,
  convertToMarkdown,
  embedStyleMap,
  extractRawText,
  images,
};
export default workerMammothSurface;
