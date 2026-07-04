/**
 * #11373 — windowed near↔far lag trajectory over a device AEC capture.
 *
 * Cross-correlates 3 s windows of the near (mic) capture against the far
 * (playback reference) at 1 s hops and prints the best lag + normalized
 * correlation per window. A flat trajectory means the transport delay is a
 * constant the seed table / one-shot self-calibration can represent; a
 * wandering one quantifies within-run delay drift (e.g. WebView audio-path
 * rebuffering), which a fixed-delay 256-tap NLMS cannot track.
 *
 * Run (bun, from the repo root):
 *   bun .github/issue-evidence/9583-aec-device-loops/driver/lag-trajectory.ts \
 *     --input <aec-loop-result.json> [--max-lag 10000]
 */

import { readFileSync } from "node:fs";

const SR = 16000;
const argvArg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const INPUT = argvArg("--input");
if (!INPUT) throw new Error("--input <aec-loop-result.json> required");
const MAXLAG = Number(argvArg("--max-lag") ?? "10000");

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

const WIN = 3 * SR;
const HOP = SR;
const corrAt = (start: number, lag: number, fe: number) => {
  let c = 0;
  let ne = 0;
  const n = near.subarray(start + lag, start + lag + WIN);
  const f = far.subarray(start, start + WIN);
  for (let i = 0; i < WIN; i += 4) {
    c += n[i] * f[i];
    ne += n[i] * n[i];
  }
  return c / Math.sqrt((ne + 1e-9) * (fe + 1e-9));
};
for (let start = 0; start + WIN + MAXLAG < near.length; start += HOP) {
  const f = far.subarray(start, start + WIN);
  let fe = 0;
  for (let i = 0; i < WIN; i++) fe += f[i] * f[i];
  if (fe / WIN < 1e-6) {
    console.log(`t=${(start / SR).toFixed(1)}s far silent`);
    continue;
  }
  let best = 0;
  let bestC = -1;
  for (let lag = 0; lag <= MAXLAG; lag += 20) {
    const c = corrAt(start, lag, fe);
    if (c > bestC) {
      bestC = c;
      best = lag;
    }
  }
  let fineBest = best;
  let fineC = -1;
  for (let lag = Math.max(0, best - 20); lag <= best + 20; lag++) {
    const c = corrAt(start, lag, fe);
    if (c > fineC) {
      fineC = c;
      fineBest = lag;
    }
  }
  console.log(
    `t=${(start / SR).toFixed(1)}s lag=${fineBest} (${((fineBest / SR) * 1000).toFixed(1)}ms) corr=${fineC.toFixed(3)}`,
  );
}
