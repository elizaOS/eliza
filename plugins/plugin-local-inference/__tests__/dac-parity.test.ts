/**
 * Host-side parity test for the DAC ConvTranspose1d collapse landed in
 * `elizaOS/llama.cpp@78c4fb190` ("tools/omnivoice: migrate dac_conv_t1d
 * to ggml_conv_transpose_1d"). Compile + shape were verified at merge
 * time; this test gates numerical parity against the captured pre-merge
 * baseline.
 *
 * Mechanism: run the current `omnivoice-codec` against a fixed RVQ
 * input blob, decode the produced WAV into f32 PCM, and compare against
 * the baseline samples captured by
 * `plugins/plugin-local-inference/native/verify/gen_dac_parity_fixture.mjs`.
 * The full DAC decoder graph runs `dac_conv_t1d` once per upsampling
 * block (5 blocks), so this one decode exercises every collapsed-op
 * site at once.
 *
 * Skip semantics: the test skips with a clear message when any of the
 * required artifacts (fixture JSON, baseline WAV, current
 * `omnivoice-codec` binary, codec GGUF) is absent. CI never fails for
 * a missing capture — see the README at
 * `plugins/plugin-local-inference/native/verify/fixtures/dac_conv_t1d_parity.README.md`
 * for the capture procedure.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface DacParityFixture {
  kernel: "dac_conv_t1d_parity";
  issue: string;
  schema_version: number;
  notes: string;
  codec_gguf_basename: string;
  codec_gguf_repo: string;
  input_rvq_basename: string;
  input_rvq_bytes: number;
  input_rvq_synthesized: boolean;
  input_rvq_k: number;
  input_rvq_t: number;
  baseline_wav_path: string;
  baseline_wav_basename: string;
  baseline_wav_bytes: number;
  baseline_sample_rate: number;
  baseline_n_samples: number;
  baseline_inline_prefix_samples: number;
  baseline_inline_prefix: number[];
  baseline_build_sha: string | null;
  baseline_build_label: string | null;
  tol_mse: number;
  tol_cosine_sim_min: number;
  tol_l1_max: number;
  generated_at: string;
}

const PLUGIN_ROOT = path.resolve(path.join(__dirname, ".."));
const FIXTURES_DIR = path.join(
  PLUGIN_ROOT,
  "native",
  "verify",
  "fixtures",
);
const DEFAULT_FIXTURE_PATH = path.join(FIXTURES_DIR, "dac_conv_t1d_parity.json");
const DEFAULT_INPUT_RVQ_PATH = path.join(
  FIXTURES_DIR,
  "dac_conv_t1d_parity.input.rvq",
);

function readFixture(): DacParityFixture | null {
  const fixturePath = process.env.DAC_PARITY_FIXTURE ?? DEFAULT_FIXTURE_PATH;
  if (!existsSync(fixturePath)) return null;
  const raw = readFileSync(fixturePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { kernel?: unknown }).kernel !== "dac_conv_t1d_parity"
  ) {
    throw new Error(`Unexpected fixture shape at ${fixturePath}`);
  }
  return parsed as DacParityFixture;
}

function findCurrentCodec(): string | null {
  const explicit = process.env.OMNIVOICE_CODEC;
  if (explicit) {
    return existsSync(explicit) ? explicit : null;
  }
  const candidates = [
    // Standard cmake build output paths under the in-repo llama.cpp.
    path.join(
      PLUGIN_ROOT,
      "native",
      "llama.cpp",
      "build",
      "bin",
      "omnivoice-codec",
    ),
    path.join(
      PLUGIN_ROOT,
      "native",
      "llama.cpp",
      "build",
      "bin",
      `${process.platform}-${process.arch}-metal-fused`,
      "omnivoice-codec",
    ),
    // omnivoice.cpp submodule's own build.
    path.join(
      PLUGIN_ROOT,
      "native",
      "omnivoice.cpp",
      "build",
      "bin",
      "omnivoice-codec",
    ),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function findCodecGguf(fixture: DacParityFixture): string | null {
  const explicit = process.env.OMNIVOICE_TOKENIZER_GGUF;
  if (explicit) {
    return existsSync(explicit) ? explicit : null;
  }
  const stateDir =
    process.env.MILADY_STATE_DIR ??
    process.env.ELIZA_STATE_DIR ??
    path.join(os.homedir(), ".eliza");
  const modelsDir = path.join(stateDir, "local-inference", "models");
  if (!existsSync(modelsDir)) return null;
  // Prefer the exact filename recorded in the fixture; otherwise look
  // for any omnivoice-tokenizer-*.gguf in the standard bundle layout.
  // We do not walk the entire tree — keep it cheap and predictable.
  const stack: string[] = [modelsDir];
  while (stack.length) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      let stat: import("node:fs").Stats;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        // Restrict to known bundle subdirs so we never recurse into
        // arbitrary trees.
        if (/^(tts|.*\.bundle)$/.test(name)) stack.push(full);
        continue;
      }
      if (name === fixture.codec_gguf_basename) return full;
    }
  }
  return null;
}

/** Decode a 16-bit / 32-bit float mono WAV into a Float32Array in [-1, 1). */
function readWavToFloat32(wavPath: string): {
  samples: Float32Array;
  sampleRate: number;
} {
  const buf = readFileSync(wavPath);
  if (buf.length < 44) throw new Error(`wav too short: ${wavPath}`);
  if (buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error(`not a RIFF: ${wavPath}`);
  }
  if (buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`not WAVE: ${wavPath}`);
  }
  if (buf.toString("ascii", 12, 16) !== "fmt ") {
    throw new Error(`expected fmt at offset 12 in ${wavPath}`);
  }
  const audioFormat = buf.readUInt16LE(20);
  const numChannels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  const fmtChunkSize = buf.readUInt32LE(16);
  const dataOffset = 20 + fmtChunkSize;
  if (buf.toString("ascii", dataOffset, dataOffset + 4) !== "data") {
    throw new Error(`missing data chunk in ${wavPath}`);
  }
  const dataSize = buf.readUInt32LE(dataOffset + 4);
  const dataStart = dataOffset + 8;
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
    `unsupported WAV format=${audioFormat} bits=${bitsPerSample} in ${wavPath}`,
  );
}

function mse(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return Number.POSITIVE_INFINITY;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    acc += d * d;
  }
  return acc / n;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

interface ResolvedHarness {
  fixture: DacParityFixture;
  codecBin: string;
  codecGguf: string;
  inputRvqPath: string;
  baselineSamples: Float32Array;
  baselineSampleRate: number;
}

function resolveHarness(): { ok: ResolvedHarness } | { skip: string } {
  const fixture = readFixture();
  if (fixture === null) {
    return {
      skip:
        "dac_conv_t1d_parity.json absent. Capture a baseline with " +
        "plugins/plugin-local-inference/native/verify/gen_dac_parity_fixture.mjs " +
        "(see fixtures/dac_conv_t1d_parity.README.md).",
    };
  }
  const inputRvqPath = process.env.DAC_PARITY_INPUT_RVQ ?? DEFAULT_INPUT_RVQ_PATH;
  if (!existsSync(inputRvqPath)) {
    return {
      skip: `input RVQ blob absent at ${inputRvqPath}. Re-run gen_dac_parity_fixture.mjs.`,
    };
  }
  if (!existsSync(fixture.baseline_wav_path)) {
    // The fixture JSON carries a small inline-prefix sample slice for
    // documentation, but full numeric parity needs the gitignored WAV.
    // When the WAV is missing, skip cleanly rather than silently
    // comparing only the prefix — a partial comparison would hide
    // regressions outside the first ~10ms of audio.
    return {
      skip: `baseline WAV absent at ${fixture.baseline_wav_path}. Re-run gen_dac_parity_fixture.mjs against a pre-merge omnivoice-codec.`,
    };
  }
  const codecBin = findCurrentCodec();
  if (codecBin === null) {
    return {
      skip:
        "current omnivoice-codec binary not found. Build it via " +
        "`node plugins/plugin-local-inference/native/build-omnivoice.mjs` " +
        "or set OMNIVOICE_CODEC to override.",
    };
  }
  const codecGguf = findCodecGguf(fixture);
  if (codecGguf === null) {
    return {
      skip:
        `codec GGUF ${fixture.codec_gguf_basename} not found under the local-inference bundles. ` +
        "Set OMNIVOICE_TOKENIZER_GGUF to override.",
    };
  }
  const baseline = readWavToFloat32(fixture.baseline_wav_path);
  return {
    ok: {
      fixture,
      codecBin,
      codecGguf,
      inputRvqPath,
      baselineSamples: baseline.samples,
      baselineSampleRate: baseline.sampleRate,
    },
  };
}

const resolved = resolveHarness();

describe.skipIf("skip" in resolved)(
  "DAC ConvTranspose1d parity (#7660)",
  () => {
    it("current omnivoice-codec decode matches captured pre-merge baseline", () => {
      if ("skip" in resolved) {
        throw new Error("describe.skipIf should have skipped this branch");
      }
      const harness = resolved.ok;

      // Run the current codec against the fixed input RVQ.
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), "dac-parity-"));
      const inputCopy = path.join(tmpDir, "input.rvq");
      writeFileSync(inputCopy, readFileSync(harness.inputRvqPath));

      const proc = spawnSync(
        harness.codecBin,
        [
          "--model",
          harness.codecGguf,
          "-i",
          inputCopy,
          "--format",
          "wav16",
        ],
        { encoding: "utf8", timeout: 300_000 },
      );
      expect(
        proc.status,
        `omnivoice-codec failed (status=${proc.status}, stderr=${proc.stderr.slice(-2000)})`,
      ).toBe(0);

      const producedWav = inputCopy.replace(/\.rvq$/, ".wav");
      expect(
        existsSync(producedWav),
        `expected output WAV at ${producedWav}`,
      ).toBe(true);

      const decoded = readWavToFloat32(producedWav);
      expect(decoded.sampleRate).toBe(harness.baselineSampleRate);

      // The decoder is deterministic for a fixed input + weights, so
      // sample count parity is a precondition for numerical parity.
      // (If the collapse changed output length, that itself is the bug.)
      expect(decoded.samples.length).toBe(harness.baselineSamples.length);

      const metricMse = mse(decoded.samples, harness.baselineSamples);
      const metricCos = cosineSim(decoded.samples, harness.baselineSamples);
      const metricL1 = maxAbsDiff(decoded.samples, harness.baselineSamples);

      // Log metrics regardless of pass/fail — debugging needs both
      // numbers when this gate ever trips.
      console.log(
        `[dac-parity] mse=${metricMse.toExponential(3)} cos=${metricCos.toFixed(6)} maxAbs=${metricL1.toExponential(3)}`,
      );

      expect(metricMse, `mse exceeded ${harness.fixture.tol_mse}`).toBeLessThanOrEqual(
        harness.fixture.tol_mse,
      );
      expect(
        metricCos,
        `cosine sim below ${harness.fixture.tol_cosine_sim_min}`,
      ).toBeGreaterThanOrEqual(harness.fixture.tol_cosine_sim_min);
      expect(
        metricL1,
        `max |diff| exceeded ${harness.fixture.tol_l1_max}`,
      ).toBeLessThanOrEqual(harness.fixture.tol_l1_max);
    });
  },
);

// Surface the skip reason in test output when we cannot resolve the
// harness. `describe.skipIf` above produces a `(skipped)` marker but
// without context — this companion describe prints the exact missing
// piece so triage is one log line instead of a forensics session.
describe.skipIf(!("skip" in resolved))(
  "DAC ConvTranspose1d parity (#7660) — skip reason",
  () => {
    it("logs why the parity test was skipped", () => {
      if (!("skip" in resolved)) {
        throw new Error("describe.skipIf should have skipped this branch");
      }
      console.warn(`[dac-parity] SKIPPED: ${resolved.skip}`);
      // The intent of this block is the log, but a passing assertion
      // keeps vitest happy without marking the suite as flaky.
      expect(resolved.skip.length).toBeGreaterThan(0);
    });
  },
);
