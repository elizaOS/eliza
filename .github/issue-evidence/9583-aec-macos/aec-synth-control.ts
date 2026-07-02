// Synthetic-echo CONTROL for the #9583 harness: same production modules, same
// frame packing, known ground truth (delay=1088, gain=0.1, -40dB noise).
import path from "node:path";
import { readFileSync } from "node:fs";
const ROOT = "/Users/shawwalters/eliza-workspace/milady/eliza/.claude/worktrees/ui-mobile-wave3";
const VOICE = path.join(ROOT, "plugins/plugin-local-inference/src/services/voice");
const { EchoReferenceBuffer } = await import(path.join(VOICE, "echo-reference-buffer.ts"));
const { NlmsEchoCanceller } = await import(path.join(VOICE, "nlms-echo-canceller.ts"));
const { computeErle } = await import(path.join(VOICE, "echo-metrics.ts"));
const SR = 16000, FRAME = 320, DELAY = 1088, GAIN = 0.1, OFFSET_MS = 1204;
function readWav(file: string): Float32Array {
  const buf = readFileSync(file); let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4); const size = buf.readUInt32LE(off + 4);
    if (id === "data") { const n = size >> 1; const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768; return out; }
    off += 8 + size + (size % 2);
  } throw new Error("no data");
}
const far = readWav(path.join(ROOT, ".github/issue-evidence/9583-aec-macos/farend-16k.wav"));
const offSamp = Math.round((OFFSET_MS / 1000) * SR);
const mic = new Float32Array(offSamp + far.length + SR);
let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
for (let i = 0; i < mic.length; i++) mic[i] = rnd() * 0.002;
for (let i = 0; i < far.length; i++) { const j = offSamp + DELAY + i; if (j < mic.length) mic[j] += far[i] * GAIN; }
const buffer = new EchoReferenceBuffer();
const canceller = new NlmsEchoCanceller({});
const farTs = (i: number) => OFFSET_MS + (i / SR) * 1000;
let farIdx = 0; const nearAct: Float32Array[] = [], residAct: Float32Array[] = [];
for (let i = 0; i + FRAME <= mic.length; i += FRAME) {
  const ts = (i / SR) * 1000;
  while (farIdx + FRAME <= far.length && farTs(farIdx) <= ts + 20) {
    buffer.pushAt(farTs(farIdx), far.subarray(farIdx, farIdx + FRAME).slice()); farIdx += FRAME;
  }
  const near = mic.subarray(i, i + FRAME);
  const ref = buffer.referenceAt(ts, FRAME, DELAY);
  let re = 0; for (let j = 0; j < FRAME; j++) re += ref[j] * ref[j];
  if (re / FRAME < 1e-7) { canceller.observeFarEndSilence(near); continue; }
  const out = canceller.process(near, ref);
  nearAct.push(near.slice()); residAct.push(out.slice());
}
const cat = (c: Float32Array[]) => { const n = c.reduce((a, x) => a + x.length, 0); const o = new Float32Array(n); let p = 0; for (const x of c) { o.set(x, p); p += x.length; } return o; };
const near = cat(nearAct), resid = cat(residAct); const half = near.length >> 1;
console.log("synthetic control: overall ERLE =", computeErle(near, resid).toFixed(2), "dB; converged-half =", computeErle(near.subarray(half), resid.subarray(half)).toFixed(2), "dB; frames =", nearAct.length);
