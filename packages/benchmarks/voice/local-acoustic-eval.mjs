// Local real-acoustic eval — runs the REAL pyannote diarizer + WeSpeaker encoder
// (current FusedDiarizer / FusedSpeakerEncoder FFI API) on real audio, on Apple
// Silicon Metal, with NO GPU runner and NO ELEVENLABS. Self-validating: it builds
// a known 2-speaker stream (speaker A + speaker B concatenated at a known boundary)
// and reports diarizer segment/speaker counts, a frame-level DER proxy, and the
// WeSpeaker cosine between the two speakers.
//
// This replaces the stale `three-voice-e2e-real.mjs` (which imports the removed
// `SpeakerEncoderGgmlImpl` / `PyannoteDiarizer` names) for the local-numbers use.
//
// Usage:
//   ELIZA_INFERENCE_LIBRARY=<…>/libelizainference.dylib \
//   ELIZA_BUNDLE_DIR=<…>/eliza-1-0_8b.bundle \
//   ELIZA_PYANNOTE_GGUF=<…>/pyannote-segmentation-3.0.gguf \
//   ELIZA_WESPEAKER_GGUF=<…>/wespeaker-resnet34-lm.gguf \
//   ELIZA_SPK_A_WAV=<…>.wav ELIZA_SPK_B_WAV=<…>.wav \
//   bun run packages/benchmarks/voice/local-acoustic-eval.mjs
//
// Requires the diarizer/speaker symbols (`eliza_inference_diariz_*` /
// `eliza_inference_speaker_*`) in the fused build. Reproduces #9460 (pyannote
// over-detection) when the linked diarizer build predates that submodule fix.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginVoice = path.resolve(
  here,
  "../../../plugins/plugin-local-inference/src/services/voice",
);
const { loadElizaInferenceFfi } = await import(
  `${pluginVoice}/ffi-bindings.ts`
);
const { FusedDiarizer } = await import(
  `${pluginVoice}/speaker/diarizer-fused.ts`
);
const { FusedSpeakerEncoder } = await import(
  `${pluginVoice}/speaker/encoder-fused.ts`
);

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};
const PYANNOTE = need("ELIZA_PYANNOTE_GGUF");
const WESPEAKER = need("ELIZA_WESPEAKER_GGUF");
const SPK_A = need("ELIZA_SPK_A_WAV");
const SPK_B = need("ELIZA_SPK_B_WAV");

function decodeWav(p) {
  const b = readFileSync(p);
  let off = 12;
  let fmt = null;
  let dataOff = 0;
  let dataLen = 0;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === "fmt ")
      fmt = {
        ch: b.readUInt16LE(off + 10),
        sr: b.readUInt32LE(off + 12),
        bits: b.readUInt16LE(off + 22),
      };
    else if (id === "data") {
      dataOff = off + 8;
      dataLen = sz;
    }
    off += 8 + sz + (sz & 1);
  }
  const n = Math.floor(dataLen / (fmt.bits / 8) / fmt.ch);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++)
    pcm[i] = b.readInt16LE(dataOff + i * 2 * fmt.ch) / 32768;
  return { pcm, sr: fmt.sr };
}
function resampleTo16k(pcm, sr) {
  if (sr === 16000) return pcm;
  const ratio = 16000 / sr;
  const out = new Float32Array(Math.floor(pcm.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i / ratio;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = (pcm[j] ?? 0) * (1 - f) + (pcm[j + 1] ?? 0) * f;
  }
  return out;
}
const take = (pcm, sec) => pcm.subarray(0, Math.min(pcm.length, sec * 16000));
function cosine(a, b) {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

const aRaw = decodeWav(SPK_A);
const a = take(resampleTo16k(aRaw.pcm, aRaw.sr), 3);
const bRaw = decodeWav(SPK_B);
const b = take(resampleTo16k(bRaw.pcm, bRaw.sr), 2);
const stream = new Float32Array(a.length + b.length);
stream.set(a, 0);
stream.set(b, a.length);
const boundarySec = a.length / 16000;
console.log(
  `stream: ${(stream.length / 16000).toFixed(2)}s  GT boundary @ ${boundarySec.toFixed(2)}s (2 speakers)`,
);

const ffi = loadElizaInferenceFfi(need("ELIZA_INFERENCE_LIBRARY"));
console.log(
  "diariz supported:",
  FusedDiarizer.isSupported(ffi),
  " speaker supported:",
  FusedSpeakerEncoder.isSupported(ffi),
);
const ctx = ffi.create(need("ELIZA_BUNDLE_DIR"));

const diar = await FusedDiarizer.load({
  ffi,
  ctx: () => ctx,
  ggufPath: PYANNOTE,
});
const segs = await diar.diarizeWindow(stream);
console.log(
  `\n[REAL pyannote] segments=${segs.segments.length}  distinct speakers=${segs.localSpeakerCount} (GT=2)`,
);

const totalMs = (stream.length / 16000) * 1000;
let correct = 0;
let total = 0;
for (let t = 0; t < totalMs; t += 10) {
  const gt = t < boundarySec * 1000 ? "A" : "B";
  const seg = segs.segments.find((s) => t >= s.startMs && t < s.endMs);
  total++;
  if (seg) {
    const isFirst = seg.localSpeakerId === segs.segments[0].localSpeakerId;
    if ((gt === "A") === isFirst) correct++;
  }
}
console.log(
  `[DER proxy] frame agreement vs 2-spk GT: ${((100 * correct) / total).toFixed(1)}% (DER≈${(100 * (1 - correct / total)).toFixed(1)}%)`,
);

const enc = await FusedSpeakerEncoder.load({
  ffi,
  ctx: () => ctx,
  ggufPath: WESPEAKER,
});
const ea = await enc.encode(a);
const eb = await enc.encode(b);
console.log(
  `\n[REAL wespeaker] dim=${ea.length}  cos(A,B)=${cosine(ea, eb).toFixed(3)} (low = correctly different speakers)`,
);
console.log("DONE");
