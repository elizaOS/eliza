#!/usr/bin/env bun
/**
 * Capture a numerical-parity baseline for the `dac_conv_t1d` migration
 * tracked in elizaOS/eliza GitHub issue #7660.
 *
 * The companion test
 *   plugins/plugin-omnivoice/__tests__/dac-conv-parity.test.ts
 * loads the baseline written by this script and compares the current
 * binary's synthesis output against it (MSE < 1e-5).
 *
 * MUST run under `bun` — the synth path goes through bun:ffi.
 *
 * ───────────── Capture workflow (run ONCE, per fixture) ─────────────
 *
 *   1. Pin omnivoice.cpp to a pre-migration commit. The migration landed
 *      as omnivoice.cpp@79079c25e ("ggml_col2im_1d -> ggml_conv_transpose_1d");
 *      any commit BEFORE that — or release tag `v1.2.0-eliza` — captures
 *      the pre-merge behaviour:
 *
 *        cd plugins/plugin-local-inference/native/omnivoice.cpp
 *        git checkout v1.2.0-eliza   # or `git checkout <sha>~1` for 79079c25e
 *
 *   2. Build the fused libomnivoice (host build):
 *
 *        bun run --cwd plugins/plugin-omnivoice build:native
 *
 *      Or follow the project's normal native-build recipe documented in
 *      plugins/plugin-local-inference/native/README.md. Set
 *      OMNIVOICE_LIB_PATH to the produced libomnivoice.{so,dylib,dll}.
 *
 *   3. Stage the bundled OmniVoice GGUFs (Serveurperso/OmniVoice-GGUF):
 *
 *        export OMNIVOICE_MODEL_PATH=/path/to/omnivoice-speech.gguf
 *        export OMNIVOICE_CODEC_PATH=/path/to/omnivoice-dac.gguf
 *
 *   4. Run this script. It writes the baseline to
 *
 *        plugins/plugin-omnivoice/__tests__/__fixtures__/dac/<name>.dacpcm
 *
 *      (override with --out=<path>).
 *
 *        bun plugins/plugin-omnivoice/scripts/capture-dac-baseline.mjs
 *
 *   5. Restore omnivoice.cpp to the post-migration pin:
 *
 *        cd plugins/plugin-local-inference/native/omnivoice.cpp
 *        git checkout master
 *
 *   6. The test now compares the post-migration build against the file
 *      from step 4. Commit the .dacpcm file alongside this script so the
 *      check is reproducible.
 *
 * ───────────── Output file layout (little-endian) ─────────────
 *   bytes  0..  7   magic 'DACPCM01'   (8 bytes ASCII)
 *   bytes  8.. 11   sample_rate         (u32)
 *   bytes 12.. 15   channels            (u32)
 *   bytes 16.. 23   num_samples         (u64)
 *   bytes 24..  N   float32 samples     (num_samples * 4 bytes)
 *
 * The reader is parseBaseline() in dac-conv-parity.test.ts. Keep the
 * two in lockstep.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

/** Canonical fixed-input vector. Keep in sync with dac-conv-parity.test.ts. */
const PARITY_FIXTURE = {
  name: "dac-parity-en-fixed",
  text: "The quick brown fox jumps over the lazy dog.",
  lang: "en",
  instruct: "female adult moderate narration moderate neutral",
  /**
   * Locks the MaskGit token generator's stochastic path so the fixed
   * input produces a deterministic Float32 PCM across runs.
   */
  seed: 7660n,
};

function parseArgs(argv) {
  let outPath = null;
  for (const arg of argv) {
    if (arg.startsWith("--out=")) {
      outPath = arg.slice("--out=".length);
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "Usage: bun capture-dac-baseline.mjs [--out=<path>]\n" +
          "See script header for the pre-merge capture workflow.\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }
  if (outPath === null) {
    outPath = path.join(
      PLUGIN_ROOT,
      "__tests__",
      "__fixtures__",
      "dac",
      `${PARITY_FIXTURE.name}.dacpcm`,
    );
  }
  return { outPath };
}

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v || v.length === 0) {
    process.stderr.write(
      `capture-dac-baseline: ${name} is required (see script header for setup)\n`,
    );
    process.exit(2);
  }
  if (!existsSync(v)) {
    process.stderr.write(
      `capture-dac-baseline: ${name} does not exist: ${v}\n`,
    );
    process.exit(2);
  }
  return v;
}

/**
 * @param {{
 *   sampleRate: number,
 *   channels: number,
 *   samples: Float32Array,
 * }} result
 * @returns {Buffer}
 */
function encodeBaseline(result) {
  const header = Buffer.alloc(24);
  header.write("DACPCM01", 0, "ascii");
  header.writeUInt32LE(result.sampleRate, 8);
  header.writeUInt32LE(result.channels, 12);
  header.writeBigUInt64LE(BigInt(result.samples.length), 16);
  const payload = Buffer.from(
    result.samples.buffer,
    result.samples.byteOffset,
    result.samples.byteLength,
  );
  return Buffer.concat([header, payload]);
}

async function main() {
  const { outPath } = parseArgs(process.argv.slice(2));
  const modelPath = requireEnv("OMNIVOICE_MODEL_PATH");
  const codecPath = requireEnv("OMNIVOICE_CODEC_PATH");

  // Dynamic import so the script can still print --help under node before
  // touching the bun:ffi-only synth path.
  const { OmnivoiceContext } = await import("../src/ffi.ts");
  const { runSynthesis } = await import("../src/synth.ts");

  const ctx = await OmnivoiceContext.open({ modelPath, codecPath });
  let result;
  try {
    result = await runSynthesis(ctx, {
      text: PARITY_FIXTURE.text,
      lang: PARITY_FIXTURE.lang,
      instruct: PARITY_FIXTURE.instruct,
      maskgit: { seed: PARITY_FIXTURE.seed },
    });
  } finally {
    ctx.close();
  }

  const outDir = path.dirname(outPath);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, encodeBaseline(result));

  process.stdout.write(
    `capture-dac-baseline: wrote ${result.samples.length} samples ` +
      `@ ${result.sampleRate} Hz / ${result.channels}ch to ${outPath}\n`,
  );
}

await main();
