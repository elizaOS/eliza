/**
 * Browser-specific PGlite initialization
 *
 * This module pre-loads PGlite's WASM and data files from the public folder
 * to work around bundler issues with PGlite's internal asset loading.
 */

import type { PGliteOptions } from "@electric-sql/pglite";
import { PGlite } from "@electric-sql/pglite";
import { fuzzystrmatch } from "@electric-sql/pglite/contrib/fuzzystrmatch";
import { vector } from "@electric-sql/pglite/vector";

// Cache the loaded assets
let fsBundleCache: Blob | null = null;
let wasmModuleCache: WebAssembly.Module | null = null;

/**
 * Pre-load PGlite assets from the public folder
 */
async function loadPGliteAssets(): Promise<{
  fsBundle: Blob;
  wasmModule: WebAssembly.Module;
}> {
  // Return cached assets if available
  if (fsBundleCache && wasmModuleCache) {
    return { fsBundle: fsBundleCache, wasmModule: wasmModuleCache };
  }

  console.log("[PGlite] Loading WASM and data assets...");

  // Load both assets in parallel
  const [dataResponse, wasmResponse] = await Promise.all([
    fetch("/pglite/pglite.data"),
    fetch("/pglite/pglite.wasm"),
  ]);

  if (!dataResponse.ok) {
    throw new Error(
      `Failed to load pglite.data: ${dataResponse.status} ${dataResponse.statusText}`,
    );
  }
  if (!wasmResponse.ok) {
    throw new Error(
      `Failed to load pglite.wasm: ${wasmResponse.status} ${wasmResponse.statusText}`,
    );
  }

  // Get the data as a blob
  fsBundleCache = await dataResponse.blob();

  // Compile the WASM module
  const wasmBuffer = await wasmResponse.arrayBuffer();
  wasmModuleCache = await WebAssembly.compile(wasmBuffer);

  console.log(
    `[PGlite] Loaded assets: data=${fsBundleCache.size} bytes, wasm compiled`,
  );

  return { fsBundle: fsBundleCache, wasmModule: wasmModuleCache };
}

/**
 * Create a PGlite instance with pre-loaded assets
 */
export async function createBrowserPGlite(
  options: Partial<PGliteOptions> = {},
): Promise<PGlite> {
  const assets = await loadPGliteAssets();

  return new PGlite({
    ...options,
    fsBundle: assets.fsBundle,
    wasmModule: assets.wasmModule,
    extensions: {
      vector,
      fuzzystrmatch,
      ...options.extensions,
    },
  });
}
