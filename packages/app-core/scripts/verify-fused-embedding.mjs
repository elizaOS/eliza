#!/usr/bin/env bun
/** Proves the installed fused library can load its companions and compute a local embedding. */
import path from "node:path";
import { resolveFusedEmbeddingBundleRoot } from "../../../plugins/plugin-local-inference/src/runtime/fused-embedding-bundle.ts";
import { resolveFusedLibraryPath } from "../../../plugins/plugin-local-inference/src/services/desktop-fused-ffi-backend-runtime.ts";
import { loadElizaInferenceFfi } from "../../../plugins/plugin-local-inference/src/services/voice/ffi-bindings.ts";

const model = process.argv[2];
if (!model) throw new Error("The verified embedding model path is required");
const bundle = resolveFusedEmbeddingBundleRoot({
  modelsDir: path.dirname(model),
  model: path.basename(model),
});
if (!bundle)
  throw new Error(`Installed embedding model is unavailable: ${model}`);
const library = resolveFusedLibraryPath(bundle);
if (!library)
  throw new Error("Installed fused inference library is unavailable");
const ffi = loadElizaInferenceFfi(library);
let context;
try {
  if (!ffi.embedSupported() || typeof ffi.embed !== "function")
    throw new Error(
      "Installed fused inference library lacks embedding support",
    );
  context = ffi.create(bundle);
  const embedding = ffi.embed({
    ctx: context,
    text: "Verify local embedding availability.",
    pooling: 1,
  });
  if (
    embedding.length !== 384 ||
    !embedding.every(Number.isFinite) ||
    !embedding.some((value) => value !== 0)
  ) {
    throw new Error(
      "Installed fused inference returned an invalid default embedding",
    );
  }
  console.log(
    `[verify-fused-embedding] ready: ${library}; ${embedding.length} finite local dimensions`,
  );
} finally {
  try {
    if (context) ffi.destroy(context);
  } finally {
    ffi.close();
  }
}
