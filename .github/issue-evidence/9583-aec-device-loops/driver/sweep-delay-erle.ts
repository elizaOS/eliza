/**
 * #11373 — ERLE-vs-delay sweep over a device AEC capture.
 *
 * The production NLMS filter is 256 taps (16 ms @16 kHz), so replay ERLE is
 * extremely sensitive to the bulk delay handed to `referenceAt`. This sweeps
 * the delay across a range and reports overall + converged-half ERLE at each
 * step through the PRODUCTION EchoReferenceBuffer/NlmsEchoCanceller/computeErle
 * — the empirical way to (a) locate the true transport delay of a capture and
 * (b) expose delay wander (no single delay recovering positive ERLE while a
 * synthetic control at the same delay does → the lag moved during the run).
 *
 * Run (bun, from the repo root):
 *   bun .github/issue-evidence/9583-aec-device-loops/driver/sweep-delay-erle.ts \
 *     --input <aec-loop-result.json> [--from 4800] [--to 8000] [--step 160]
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const VOICE = path.join(
  ROOT,
  "plugins/plugin-local-inference/src/services/voice",
);
const { EchoReferenceBuffer } = await import(
  path.join(VOICE, "echo-reference-buffer.ts")
);
const { NlmsEchoCanceller } = await import(
  path.join(VOICE, "nlms-echo-canceller.ts")
);
const { computeErle } = await import(path.join(VOICE, "echo-metrics.ts"));

const SR = 16000;
const FRAME = 320;

const argvArg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const INPUT = argvArg("--input");
if (!INPUT) throw new Error("--input <aec-loop-result.json> required");
const FROM = Number(argvArg("--from") ?? "4800");
const TO = Number(argvArg("--to") ?? "8000");
const STEP = Number(argvArg("--step") ?? "160");

const raw = JSON.parse(readFileSync(INPUT, "utf8"));
const cap = raw.aecCapture?.capture ?? raw.aecCapture;
const dec = (b64: string): Float32Array => {
  const buf = Buffer.from(b64, "base64");
  const out = new Float32Array(buf.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
};
const near = dec(cap.nearPcm16);
const far = dec(cap.farPcm16);

function erleAt(delay: number): { overall: number; half: number } {
  const buffer = new EchoReferenceBuffer();
  const canc = new NlmsEchoCanceller({});
  const nearA: Float32Array[] = [];
  const residA: Float32Array[] = [];
  for (let i = 0; i + FRAME <= near.length; i += FRAME) {
    const ts = (i / SR) * 1000;
    buffer.pushAt(ts, far.subarray(i, i + FRAME));
    const nf = near.subarray(i, i + FRAME);
    const ref = buffer.referenceAt(ts, FRAME, delay);
    let re = 0;
    for (let j = 0; j < FRAME; j++) re += ref[j] * ref[j];
    if (re / FRAME < 1e-7) {
      canc.observeFarEndSilence(nf);
      continue;
    }
    const out = canc.process(nf, ref);
    nearA.push(nf.slice());
    residA.push(out.slice());
  }
  const cat = (c: Float32Array[]) => {
    const n = c.reduce((a, x) => a + x.length, 0);
    const m = new Float32Array(n);
    let o = 0;
    for (const x of c) {
      m.set(x, o);
      o += x.length;
    }
    return m;
  };
  const nc = cat(nearA);
  const rc = cat(residA);
  const h = nc.length >> 1;
  return {
    overall: computeErle(nc, rc),
    half: computeErle(nc.subarray(h), rc.subarray(h)),
  };
}

for (let d = FROM; d <= TO; d += STEP) {
  const r = erleAt(d);
  console.log(
    `delay=${d} (${((d / SR) * 1000).toFixed(1)}ms) overall=${r.overall.toFixed(2)} dB converged-half=${r.half.toFixed(2)} dB`,
  );
}
