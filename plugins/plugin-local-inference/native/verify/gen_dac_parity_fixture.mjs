#!/usr/bin/env node
/**
 * Generate the DAC ConvTranspose1d parity fixture for elizaOS/eliza#7660.
 *
 * Background:
 *   `elizaOS/llama.cpp@78c4fb190` ("tools/omnivoice: migrate dac_conv_t1d to
 *   ggml_conv_transpose_1d") collapsed the 5-step host-side decomposition
 *   (transpose -> mul_mat -> col2im_1d -> pad -> add_bias) into a single
 *   `ggml_conv_transpose_1d` call inside `tools/omnivoice/src/dac-decoder.h`.
 *   The change compiles cleanly and shapes match, but numerical parity
 *   against the pre-merge build was never gated by a test. This script
 *   captures the pre-merge baseline so the companion vitest can compare
 *   the current build's decode output against it.
 *
 * What the fixture exercises:
 *   The full DAC decoder graph runs `dac_conv_t1d` once per upsampling
 *   block (5 blocks), so a deterministic decode of a fixed RVQ code stream
 *   through `omnivoice-codec` covers every collapsed-op site at once.
 *
 * Inputs (provided to this script):
 *   - `omnivoice-codec` binary (built from the BASELINE llama.cpp checkout).
 *   - OmniVoice tokenizer GGUF (codec GGUF; typically
 *     `tts/omnivoice-tokenizer-0.8b.gguf` from `Serveurperso/OmniVoice-GGUF`).
 *   - A fixed input `.rvq` blob (this script auto-generates one if absent,
 *     using deterministic counter-stream codes — see `synthesizeRvq`).
 *
 * Outputs (under `--out-dir`, default
 * `plugins/plugin-local-inference/native/verify/fixtures/`):
 *   - `dac_conv_t1d_parity.json` — git-tracked metadata + small inline
 *     prefix samples for compact CI smoke. Tolerance `mse <= 1e-5` and
 *     `cosine_sim >= 0.9999` against the pre-merge build.
 *   - `dac_conv_t1d_parity.input.rvq` — git-tracked deterministic RVQ
 *     code blob (tiny, ~ a few hundred bytes).
 *   - `dac_conv_t1d_parity.baseline.wav` — gitignored full PCM dump.
 *     Lives under `verify/bench_results/` (already gitignored) when
 *     `--baseline-out-dir` is omitted; the JSON fixture's
 *     `baseline_wav_path` field points at the path used.
 *
 * Usage (capture against pre-merge build):
 *   node plugins/plugin-local-inference/native/verify/gen_dac_parity_fixture.mjs \
 *     --omnivoice-codec /path/to/pre-merge/omnivoice-codec \
 *     --codec-gguf ~/.eliza/local-inference/models/eliza-1-2b.bundle/tts/omnivoice-tokenizer-0.8b.gguf \
 *     --baseline-build-sha <pre-merge-sha>
 *
 * "Pre-merge" means before `elizaOS/llama.cpp@78c4fb190` ("migrate
 * dac_conv_t1d to ggml_conv_transpose_1d"). The known-good reference
 * tag the eliza fork ships is `v1.2.0-eliza`; alternatively any commit
 * before `79079c25e` ("merge: upstream/master into milady/main") works.
 * The exact SHA captured goes into the fixture's `baseline_build_sha`
 * field so reviewers can reproduce.
 *
 * The companion vitest at
 * `plugins/plugin-local-inference/__tests__/dac-parity.test.ts` loads
 * the JSON, runs the CURRENT `omnivoice-codec` against the SAME input
 * `.rvq` blob, and asserts mse + cosine similarity against the baseline.
 * The test skips with a clear message when the JSON or its referenced
 * baseline WAV is absent so CI never fails for a missing capture.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { argv, exit } from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Deterministic codes used when the caller does not pass an explicit
 * `--input-rvq`. K is fixed by the codec GGUF (8 codebooks); T is small
 * (12 frames) so the parity check stays fast — a 12-frame decode still
 * walks every `dac_conv_t1d` site since the decoder graph is independent
 * of T beyond input length.
 */
const DEFAULT_K = 8;
const DEFAULT_T = 12;
const RVQ_CODE_BITS = 11;
const RVQ_CODE_MASK = (1 << RVQ_CODE_BITS) - 1;

/** Pack [K, T] codes into the 11-bit LSB-first format omnivoice-codec reads. */
function packRvq(codes) {
  const totalBits = codes.length * RVQ_CODE_BITS;
  const out = new Uint8Array(Math.ceil(totalBits / 8));
  let acc = 0n;
  let bits = 0;
  let pos = 0;
  for (const c of codes) {
    acc |= BigInt(c & RVQ_CODE_MASK) << BigInt(bits);
    bits += RVQ_CODE_BITS;
    while (bits >= 8) {
      out[pos++] = Number(acc & 0xffn);
      acc >>= 8n;
      bits -= 8;
    }
  }
  if (bits > 0) {
    out[pos++] = Number(acc & 0xffn);
  }
  return out;
}

/**
 * Build a deterministic K*T code stream. Codes are a low-magnitude
 * counter (mod 256) per codebook with an explicit prime offset between
 * codebooks so each codebook sees distinct entries. Keeps every code
 * well inside the V <= 2048 range that the 11-bit RVQ format encodes.
 */
function synthesizeRvq(k, t) {
  const codes = new Int32Array(k * t);
  for (let frame = 0; frame < t; frame++) {
    for (let cb = 0; cb < k; cb++) {
      codes[frame * k + cb] = (frame * 7 + cb * 19) & 0xff;
    }
  }
  return codes;
}

function parseArgs(args) {
  const result = {
    omnivoiceCodec: process.env.OMNIVOICE_CODEC ?? null,
    codecGguf: process.env.OMNIVOICE_TOKENIZER_GGUF ?? null,
    inputRvq: null,
    outDir: join(__dirname, "fixtures"),
    baselineOutDir: null,
    baselineBuildSha: null,
    baselineBuildLabel: null,
    notes: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--omnivoice-codec") result.omnivoiceCodec = args[++i];
    else if (a === "--codec-gguf") result.codecGguf = args[++i];
    else if (a === "--input-rvq") result.inputRvq = args[++i];
    else if (a === "--out-dir") result.outDir = args[++i];
    else if (a === "--baseline-out-dir") result.baselineOutDir = args[++i];
    else if (a === "--baseline-build-sha") result.baselineBuildSha = args[++i];
    else if (a === "--baseline-build-label") result.baselineBuildLabel = args[++i];
    else if (a === "--notes") result.notes = args[++i];
    else if (a === "-h" || a === "--help") {
      printUsage();
      exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printUsage();
      exit(2);
    }
  }
  return result;
}

function printUsage() {
  console.error(
    [
      "Usage: gen_dac_parity_fixture.mjs --omnivoice-codec <bin> --codec-gguf <gguf>",
      "                                  [--baseline-build-sha <sha>] [--input-rvq <path>]",
      "                                  [--out-dir <dir>] [--baseline-out-dir <dir>]",
      "                                  [--baseline-build-label <label>] [--notes <text>]",
      "",
      "  --omnivoice-codec   pre-merge `omnivoice-codec` binary (env: OMNIVOICE_CODEC)",
      "  --codec-gguf        OmniVoice tokenizer GGUF (env: OMNIVOICE_TOKENIZER_GGUF)",
      "  --input-rvq         optional fixed input. Synthesized when absent.",
      "  --out-dir           where the fixture JSON + .rvq blob land",
      "                      (default: <verify>/fixtures/)",
      "  --baseline-out-dir  where the baseline .wav lands. Default:",
      "                      <verify>/bench_results/ (gitignored).",
      "  --baseline-build-sha   recorded in the JSON. Pre-merge llama.cpp SHA.",
      "  --baseline-build-label optional human label (e.g. 'v1.2.0-eliza').",
    ].join("\n"),
  );
}

/** Read a 16-bit little-endian PCM WAV into a Float32Array, normalized to [-1, 1). */
function readWavToFloat32(wavPath) {
  const buf = readFileSync(wavPath);
  if (buf.length < 44) {
    throw new Error(`wav too short: ${wavPath}`);
  }
  // Minimal RIFF parse — omnivoice-codec writes a canonical PCM WAV with
  // a single `fmt` chunk followed by `data`. We do not bother with
  // generic chunk skipping because the writer is in-tree.
  const riff = buf.toString("ascii", 0, 4);
  const wave = buf.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error(`not a WAV: ${wavPath}`);
  }
  const fmt = buf.toString("ascii", 12, 16);
  if (fmt !== "fmt ") {
    throw new Error(`unexpected chunk at offset 12: ${fmt}`);
  }
  const audioFormat = buf.readUInt16LE(20);
  const numChannels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  const fmtChunkSize = buf.readUInt32LE(16);
  const dataChunkOffset = 20 + fmtChunkSize;
  const dataTag = buf.toString("ascii", dataChunkOffset, dataChunkOffset + 4);
  if (dataTag !== "data") {
    throw new Error(`expected 'data' chunk, got '${dataTag}' at ${dataChunkOffset}`);
  }
  const dataSize = buf.readUInt32LE(dataChunkOffset + 4);
  const dataStart = dataChunkOffset + 8;
  if (numChannels !== 1) {
    throw new Error(`expected mono, got ${numChannels} channels`);
  }
  if (audioFormat === 1 && bitsPerSample === 16) {
    const nSamples = dataSize / 2;
    const out = new Float32Array(nSamples);
    for (let i = 0; i < nSamples; i++) {
      out[i] = buf.readInt16LE(dataStart + i * 2) / 32768;
    }
    return { samples: out, sampleRate };
  }
  if (audioFormat === 3 && bitsPerSample === 32) {
    const nSamples = dataSize / 4;
    const out = new Float32Array(nSamples);
    for (let i = 0; i < nSamples; i++) {
      out[i] = buf.readFloatLE(dataStart + i * 4);
    }
    return { samples: out, sampleRate };
  }
  throw new Error(
    `unsupported WAV format=${audioFormat} bits=${bitsPerSample}`,
  );
}

function main() {
  const args = parseArgs(argv.slice(2));

  if (!args.omnivoiceCodec) {
    console.error("error: --omnivoice-codec is required");
    printUsage();
    exit(2);
  }
  if (!existsSync(args.omnivoiceCodec)) {
    console.error(`error: omnivoice-codec not found: ${args.omnivoiceCodec}`);
    exit(2);
  }
  if (!args.codecGguf) {
    console.error("error: --codec-gguf is required");
    printUsage();
    exit(2);
  }
  if (!existsSync(args.codecGguf)) {
    console.error(`error: codec GGUF not found: ${args.codecGguf}`);
    exit(2);
  }

  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });
  const baselineOutDir = resolve(
    args.baselineOutDir ?? join(__dirname, "bench_results"),
  );
  mkdirSync(baselineOutDir, { recursive: true });

  // Resolve or synthesize the input RVQ blob.
  const rvqPath = join(outDir, "dac_conv_t1d_parity.input.rvq");
  let rvqK = DEFAULT_K;
  let rvqT = DEFAULT_T;
  if (args.inputRvq) {
    if (!existsSync(args.inputRvq)) {
      console.error(`error: --input-rvq not found: ${args.inputRvq}`);
      exit(2);
    }
    const buf = readFileSync(args.inputRvq);
    writeFileSync(rvqPath, buf);
    // We cannot reliably infer T without knowing K (which lives in the
    // GGUF) — record what the caller supplied as authoritative.
    rvqK = -1;
    rvqT = -1;
    console.log(`[gen_dac_parity] copied caller-provided RVQ -> ${rvqPath}`);
  } else {
    const codes = synthesizeRvq(rvqK, rvqT);
    const packed = packRvq(Array.from(codes));
    writeFileSync(rvqPath, packed);
    console.log(
      `[gen_dac_parity] synthesized RVQ K=${rvqK} T=${rvqT} -> ${rvqPath} (${packed.length} bytes)`,
    );
  }

  // Run the pre-merge omnivoice-codec to produce the baseline WAV.
  // omnivoice-codec writes its output next to the input by swapping the
  // extension, so we hand it the rvq and pick up the .wav sibling.
  console.log(
    `[gen_dac_parity] invoking baseline omnivoice-codec: ${args.omnivoiceCodec}`,
  );
  const proc = spawnSync(
    args.omnivoiceCodec,
    ["--model", args.codecGguf, "-i", rvqPath, "--format", "wav16"],
    { encoding: "utf8", timeout: 300_000 },
  );
  if (proc.status !== 0) {
    console.error(`[gen_dac_parity] codec failed (status=${proc.status})`);
    console.error(proc.stderr?.slice(-2000) ?? "");
    exit(1);
  }
  const producedWav = rvqPath.replace(/\.rvq$/, ".wav");
  if (!existsSync(producedWav)) {
    console.error(`[gen_dac_parity] expected output WAV at ${producedWav}`);
    exit(1);
  }

  // Move/copy the produced wav into the baseline output dir.
  const baselineWav = join(baselineOutDir, "dac_conv_t1d_parity.baseline.wav");
  writeFileSync(baselineWav, readFileSync(producedWav));
  console.log(`[gen_dac_parity] wrote baseline WAV -> ${baselineWav}`);

  // Decode the WAV into f32 PCM so the JSON can carry a tiny inline
  // prefix for fast smoke. Keep the prefix small (default 256 samples)
  // because the JSON is git-tracked.
  const decoded = readWavToFloat32(baselineWav);
  const inlinePrefixSamples = Math.min(256, decoded.samples.length);
  const inlinePrefix = Array.from(
    decoded.samples.slice(0, inlinePrefixSamples),
    (v) => Number.parseFloat(v.toFixed(6)),
  );

  const fixture = {
    kernel: "dac_conv_t1d_parity",
    issue: "elizaOS/eliza#7660",
    schema_version: 1,
    notes: args.notes ??
      "Host-side parity gate for the post-78c4fb190 ggml_conv_transpose_1d collapse in tools/omnivoice/src/dac-decoder.h. Decode-only path through the DAC decoder graph exercises every dac_conv_t1d site (5 upsampling blocks). Run companion vitest after rebuilding omnivoice-codec from a current llama.cpp checkout.",
    codec_gguf_basename: basename(args.codecGguf),
    codec_gguf_repo: "Serveurperso/OmniVoice-GGUF",
    input_rvq_basename: basename(rvqPath),
    input_rvq_bytes: statSync(rvqPath).size,
    input_rvq_synthesized: !args.inputRvq,
    input_rvq_k: rvqK,
    input_rvq_t: rvqT,
    baseline_wav_path: baselineWav,
    baseline_wav_basename: basename(baselineWav),
    baseline_wav_bytes: statSync(baselineWav).size,
    baseline_sample_rate: decoded.sampleRate,
    baseline_n_samples: decoded.samples.length,
    baseline_inline_prefix_samples: inlinePrefixSamples,
    baseline_inline_prefix: inlinePrefix,
    baseline_build_sha: args.baselineBuildSha ?? null,
    baseline_build_label: args.baselineBuildLabel ?? null,
    tol_mse: 1e-5,
    tol_cosine_sim_min: 0.9999,
    tol_l1_max: 1e-2,
    generated_at: new Date().toISOString(),
  };
  const fixturePath = join(outDir, "dac_conv_t1d_parity.json");
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`[gen_dac_parity] wrote fixture -> ${fixturePath}`);
  console.log(
    `[gen_dac_parity] tolerances: mse <= ${fixture.tol_mse}, cos >= ${fixture.tol_cosine_sim_min}, |max| <= ${fixture.tol_l1_max}`,
  );
}

main();
