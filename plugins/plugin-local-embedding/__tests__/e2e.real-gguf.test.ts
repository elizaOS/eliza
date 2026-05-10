import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real-GGUF end-to-end test.
 *
 * Loads a real embedding model from disk (no HuggingFace fetch) and
 * exercises the live node-llama-cpp pipeline through `LocalEmbeddingManager`.
 * Gated behind `LOCAL_EMBEDDING_RUN_E2E=1` so CI doesn't run it without an
 * explicit opt-in — the binding builds vary by host (CUDA/Metal/Vulkan/CPU)
 * and the model file is not committed to the repo.
 *
 * To run locally:
 *   1. Make sure a GGUF embedding model is on disk under MODELS_DIR
 *      (default `~/.eliza/models`). The test auto-detects
 *      `nomic-embed-text-v1.5.{Q4_K_M,Q5_K_M}.gguf` or
 *      `bge-small-en-v1.5.Q4_K_M.gguf`.
 *   2. `LOCAL_EMBEDDING_RUN_E2E=1 LOCAL_EMBEDDING_FORCE_CPU=1 \
 *       bun test plugins/plugin-local-embedding/__tests__/e2e.real-gguf.test.ts`
 *
 * Coverage:
 *   - Loads a real GGUF via the production code path (probe → ensureLlama
 *     → loadEmbeddingModel → createEmbeddingContext).
 *   - Embeds 100 single inputs sequentially via the public TEXT_EMBEDDING
 *     entrypoint, then embeds the same 100 inputs as one batched call.
 *     Verifies per-input outputs match (L2 distance ≤ 1e-3 per pair).
 *   - Embeds a single ~32k-token document via the chunking path; verifies
 *     the output dimension matches the declared model dimension and the
 *     pooled vector is L2-normalised.
 */

const RUN_E2E = process.env.LOCAL_EMBEDDING_RUN_E2E === "1";
const describeIfE2e = RUN_E2E ? describe : describe.skip;

interface ModelCandidate {
  fileName: string;
  dimensions: number;
  contextSize: number;
}

const MODEL_CANDIDATES: ModelCandidate[] = [
  { fileName: "nomic-embed-text-v1.5.Q4_K_M.gguf", dimensions: 768, contextSize: 8192 },
  { fileName: "nomic-embed-text-v1.5.Q5_K_M.gguf", dimensions: 768, contextSize: 8192 },
  { fileName: "bge-small-en-v1.5.Q4_K_M.gguf", dimensions: 384, contextSize: 512 },
];

function pickAvailableModel(modelsDir: string): ModelCandidate | null {
  for (const candidate of MODEL_CANDIDATES) {
    const filePath = path.join(modelsDir, candidate.fileName);
    if (fs.existsSync(filePath)) {
      const fd = fs.openSync(filePath, "r");
      try {
        const header = Buffer.alloc(4);
        fs.readSync(fd, header, 0, header.length, 0);
        if (header.toString("ascii", 0, 4) === "GGUF") return candidate;
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  return null;
}

function l2Distance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function l2Norm(v: number[]): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}

const modelsDir =
  process.env.MODELS_DIR?.trim() ||
  process.env.LOCAL_EMBEDDING_MODELS_DIR?.trim() ||
  path.join(os.homedir(), ".eliza", "models");

const picked = RUN_E2E ? pickAvailableModel(modelsDir) : null;

if (RUN_E2E && !picked) {
  // Make this a hard failure when E2E is requested — silent skip is the
  // wrong behavior because the operator explicitly asked for a real run.
  throw new Error(
    `LOCAL_EMBEDDING_RUN_E2E=1 but no candidate GGUF found under ${modelsDir}. ` +
      `Expected one of: ${MODEL_CANDIDATES.map((c) => c.fileName).join(", ")}`,
  );
}

describeIfE2e("plugin-local-embedding e2e (real GGUF)", () => {
  beforeAll(() => {
    if (!picked) return;
    process.env.LOCAL_EMBEDDING_MODEL = picked.fileName;
    process.env.LOCAL_EMBEDDING_DIMENSIONS = String(picked.dimensions);
    process.env.LOCAL_EMBEDDING_CONTEXT_SIZE = String(picked.contextSize);
    process.env.MODELS_DIR = modelsDir;
    // Default to CPU on hosts that don't have CUDA visible — the e2e
    // assertions don't depend on backend, but we don't want the test to
    // accidentally try to allocate GPU memory in CI.
    if (!process.env.CUDA_VISIBLE_DEVICES) {
      process.env.LOCAL_EMBEDDING_FORCE_CPU = process.env.LOCAL_EMBEDDING_FORCE_CPU ?? "1";
    }
  });

  afterAll(() => {
    delete process.env.LOCAL_EMBEDDING_MODEL;
    delete process.env.LOCAL_EMBEDDING_DIMENSIONS;
    delete process.env.LOCAL_EMBEDDING_CONTEXT_SIZE;
  });

  it(
    "loads the GGUF and embeds a smoke input",
    async () => {
      const mod = await import("../src/index.ts");
      const manager = mod.LocalEmbeddingManager.getInstance();
      const vec = await manager.generateEmbedding("Hello, world.");
      expect(vec).toBeInstanceOf(Array);
      expect(vec.length).toBe(picked!.dimensions);
      // L2-normalised by default.
      expect(l2Norm(vec)).toBeCloseTo(1.0, 4);
      // No NaN / Infinity slipping through the binding.
      for (const v of vec) {
        expect(Number.isFinite(v)).toBe(true);
      }
    },
    600_000,
  );

  it(
    "single-input and batched-100 paths match within 1e-3 L2 per pair",
    async () => {
      const mod = await import("../src/index.ts");
      const manager = mod.LocalEmbeddingManager.getInstance();
      const inputs = Array.from(
        { length: 100 },
        (_, i) => `Sample sentence number ${i}: the quick brown fox jumps over fence ${i}.`,
      );

      const sequential: number[][] = [];
      for (const text of inputs) {
        sequential.push(await manager.generateEmbedding(text));
      }
      const batched = await manager.generateEmbeddings(inputs);
      expect(batched).toHaveLength(inputs.length);

      let maxDist = 0;
      let worstIndex = -1;
      for (let i = 0; i < inputs.length; i += 1) {
        const d = l2Distance(sequential[i], batched[i]);
        if (d > maxDist) {
          maxDist = d;
          worstIndex = i;
        }
      }
      // Document the worst pair so a regression is easier to triage.
      // node-llama-cpp's getEmbeddingFor is deterministic for a fixed
      // input; matching shouldn't drift across the two call paths.
      expect(maxDist, `worst pair index=${worstIndex}, distance=${maxDist}`).toBeLessThanOrEqual(
        1e-3,
      );
    },
    600_000,
  );

  it(
    "chunks a 32k-token document and emits a normalised dim-N vector",
    async () => {
      const mod = await import("../src/index.ts");
      const manager = mod.LocalEmbeddingManager.getInstance();

      // ~32k tokens at the conventional 4 chars/token estimate.
      // The plugin uses 92% of contextSize as the chunk window, so this
      // forces multiple chunks for nomic (8192 ctx → ~7536 tok window)
      // and many chunks for bge-small (512 ctx → ~470 tok window).
      const charCount = 32_000 * 4;
      const longDoc = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(
        Math.ceil(charCount / 57),
      );
      const vec = await manager.generateEmbedding(longDoc);
      expect(vec.length).toBe(picked!.dimensions);
      expect(l2Norm(vec)).toBeCloseTo(1.0, 4);
      for (const v of vec) {
        expect(Number.isFinite(v)).toBe(true);
      }
    },
    600_000,
  );
});
