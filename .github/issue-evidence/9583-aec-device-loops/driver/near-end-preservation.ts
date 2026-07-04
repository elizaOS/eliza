/**
 * #11373 — double-talk near-end preservation over a device AEC capture.
 *
 * "Near-end speech not crushed" quantified: replay the capture through the
 * PRODUCTION EchoReferenceBuffer + NlmsEchoCanceller (same classes the live
 * path runs), align the known near-end source speech inside the mic capture
 * by cross-correlation, then compare the matched-filter projection of the
 * near-end source in the raw mic vs in the canceller residual, per 1 s
 * window and overall:
 *
 *   a_near(w)  = <near_w,  src_w> / <src_w, src_w>
 *   a_resid(w) = <resid_w, src_w> / <src_w, src_w>
 *   preservation(w) dB = 20·log10(|a_resid| / |a_near|)   (0 dB = untouched)
 *
 * The projection measures only the component correlated with the dry source,
 * so echo/noise (uncorrelated with the near-end speech) cancels out of the
 * ratio.
 *
 * Run (bun, from the repo root):
 *   bun .github/issue-evidence/9583-aec-device-loops/driver/near-end-preservation.ts \
 *     --input <aec-loop-result-double-talk.json> --near-source <near-16k.wav> \
 *     [--delay <samples>]   (default: the capture's self-calibrated delay)
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

const SR = 16000;
const FRAME = 320;

const argvArg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const INPUT = argvArg("--input");
const NEAR_SOURCE = argvArg("--near-source");
if (!INPUT || !NEAR_SOURCE) {
  throw new Error("--input <result.json> and --near-source <wav> required");
}

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
const DELAY = Number(argvArg("--delay") ?? cap.echoDelaySamples ?? 0);

function readWav(file: string): Float32Array {
  const buf = readFileSync(file);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      const n = size >> 1;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++)
        out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}
const src = readWav(NEAR_SOURCE);

// ── Replay the production canceller at DELAY ───────────────────────────────
const buffer = new EchoReferenceBuffer();
const canceller = new NlmsEchoCanceller({});
const residual = new Float32Array(near.length);
for (let i = 0; i + FRAME <= near.length; i += FRAME) {
  const ts = (i / SR) * 1000;
  buffer.pushAt(ts, far.subarray(i, i + FRAME));
  const nf = near.subarray(i, i + FRAME);
  const ref = buffer.referenceAt(ts, FRAME, DELAY);
  let re = 0;
  for (let j = 0; j < FRAME; j++) re += ref[j] * ref[j];
  if (re / FRAME < 1e-7) {
    canceller.observeFarEndSilence(nf);
    residual.set(nf, i);
    continue;
  }
  residual.set(canceller.process(nf, ref), i);
}

// ── Align the near-end source inside the mic capture ──────────────────────
const WIN = 4 * SR;
const probe = src.subarray(2 * SR, 2 * SR + WIN);
let pe = 0;
for (let i = 0; i < WIN; i++) pe += probe[i] * probe[i];
let best = 0;
let bestC = -1;
const corrAt = (off: number, stride: number) => {
  let c = 0;
  let ne = 0;
  const n = near.subarray(off, off + WIN);
  for (let i = 0; i < WIN; i += stride) {
    c += n[i] * probe[i];
    ne += n[i] * n[i];
  }
  return c / Math.sqrt((ne + 1e-9) * (pe + 1e-9));
};
for (let off = 0; off + WIN < near.length; off += 40) {
  const c = corrAt(off, 4);
  if (c > bestC) {
    bestC = c;
    best = off;
  }
}
let fineBest = best;
let fineC = -1;
for (let off = Math.max(0, best - 40); off <= best + 40; off++) {
  const c = corrAt(off, 1);
  if (c > fineC) {
    fineC = c;
    fineBest = off;
  }
}
const srcStartInCapture = fineBest - 2 * SR;
console.log(
  `[align] near-end source starts at ${(srcStartInCapture / SR).toFixed(2)}s in the capture (corr ${fineC.toFixed(3)} @ probe)`,
);

// ── Per-window matched-filter projection: raw mic vs residual ──────────────
const HOP = SR;
const ratios: number[] = [];
for (let s = 0; s + HOP <= src.length; s += HOP) {
  const capOff = srcStartInCapture + s;
  if (capOff < 0 || capOff + HOP > near.length) continue;
  const w = src.subarray(s, s + HOP);
  let we = 0;
  for (let i = 0; i < HOP; i++) we += w[i] * w[i];
  if (we / HOP < 1e-5) continue; // near-end silent in this second
  let an = 0;
  let ar = 0;
  for (let i = 0; i < HOP; i++) {
    an += near[capOff + i] * w[i];
    ar += residual[capOff + i] * w[i];
  }
  an /= we;
  ar /= we;
  if (Math.abs(an) < 1e-6) continue;
  const db = 20 * Math.log10(Math.abs(ar) / Math.abs(an));
  ratios.push(db);
  console.log(
    `[window] t=${(s / SR).toFixed(0)}s near-coef=${an.toFixed(4)} resid-coef=${ar.toFixed(4)} preservation=${db.toFixed(2)} dB`,
  );
}
const mean = ratios.reduce((a, b) => a + b, 0) / Math.max(1, ratios.length);
console.log(
  `[overall] mean near-end preservation ${mean.toFixed(2)} dB over ${ratios.length} voiced windows (0 dB = untouched; strongly negative = crushed) at replay delay ${DELAY}`,
);
