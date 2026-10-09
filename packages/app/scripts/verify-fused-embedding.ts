#!/usr/bin/env bun
/** Verifies the pinned canonical BGE path, including native reopen and semantic separation. */
import path from "node:path";
import {
  createVerifiedBgeContext,
  resolveEmbeddingBackendPolicy,
} from "../../../plugins/plugin-local-inference/src/runtime/embedding-backend.ts";
import { selectEmbeddingPresetFromHardware } from "../../../plugins/plugin-local-inference/src/runtime/embedding-presets.ts";
import {
  embedBgeInput,
  normalizeEmbeddingVector,
  resolveBgeContextLimit,
  resolveEmbeddingPooling,
  verifyBgeEmbeddingBundle,
} from "../../../plugins/plugin-local-inference/src/runtime/embedding-vector-space.ts";
import { resolveFusedEmbeddingBundleRoot } from "../../../plugins/plugin-local-inference/src/runtime/fused-embedding-bundle.ts";
import { resolveFusedLibraryPath } from "../../../plugins/plugin-local-inference/src/services/desktop-fused-ffi-backend-runtime.ts";
import { probeHardware } from "../../../plugins/plugin-local-inference/src/services/hardware.ts";
import { loadElizaInferenceFfi } from "../../../plugins/plugin-local-inference/src/services/voice/ffi-bindings.ts";

const model = process.argv[2];
if (!model) throw new Error("The verified embedding model path is required");
const bundle = resolveFusedEmbeddingBundleRoot({
  modelsDir: path.dirname(model),
  model: path.basename(model),
});
if (!bundle)
  throw new Error(`Installed embedding model is unavailable: ${model}`);
const space = verifyBgeEmbeddingBundle(bundle, path.basename(model));
if (!space)
  throw new Error("The installer requires the pinned canonical BGE model");
const library = resolveFusedLibraryPath(bundle);
if (!library)
  throw new Error("Installed fused inference library is unavailable");
const pooling = resolveEmbeddingPooling(
  path.basename(model),
  process.env.ELIZA_EMBED_POOLING,
);
const contextLimit = resolveBgeContextLimit(process.env.ELIZA_EMBED_N_CTX);
const hardware = await probeHardware();
const preset = selectEmbeddingPresetFromHardware(hardware);
const policy = resolveEmbeddingBackendPolicy(
  process.env.LOCAL_EMBEDDING_GPU_LAYERS,
  preset.gpuLayers === "auto" ? 999 : 0,
);
// Reopening must remain safe after releasing the first model and binding.
for (let cycle = 0; cycle < 2; cycle += 1) {
  const ffi = loadElizaInferenceFfi(library);
  let context;
  try {
    if (
      !ffi.embedSupported?.() ||
      typeof ffi.embed !== "function" ||
      typeof ffi.tokenize !== "function"
    ) {
      throw new Error(
        "Installed fused inference library lacks canonical embedding/tokenizer support",
      );
    }
    const selected = createVerifiedBgeContext(
      ffi,
      bundle,
      policy,
      pooling,
      contextLimit,
    );
    context = selected.ctx;
    const { related, unrelated, gpuLayers } = selected;
    const tail = embedBgeInput(
      `${"An earlier sentence. ".repeat(600)}The cat is sleeping on the sofa.`,
      (text) =>
        ffi.tokenize({
          ctx: context,
          text,
          addSpecial: true,
          parseSpecial: true,
        }),
      (text) => ffi.embed({ ctx: context, text, pooling, parseSpecial: true }),
      contextLimit,
    );
    if (tail.length !== 384)
      throw new Error("Canonical BGE must return 384 dimensions");
    normalizeEmbeddingVector(tail);
    console.log(
      `[verify-fused-embedding] ready: ${library}; ${space}; gpuLayers=${gpuLayers}; related=${related}; unrelated=${unrelated}; cycle ${cycle + 1}/2`,
    );
  } finally {
    try {
      if (context) ffi.destroy(context);
    } finally {
      ffi.close();
    }
  }
}
