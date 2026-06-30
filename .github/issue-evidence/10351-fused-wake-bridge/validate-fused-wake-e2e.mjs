/**
 * REAL end-to-end validation of the fused on-device wake bridge (#10351).
 *
 *   real libwakeword.dylib (bun:ffi)  +  real hey-eliza GGUFs  +  real PCM clip
 *     → OpenWakeWordGgmlModel.scoreFrame()           (the production bun:ffi binding)
 *     → OpenWakeWordDetector (sustain + refractory)   (the production streaming gate)
 *     → bridgeDetectorToFusedWake(sink)               (the #10351 producer bridge)
 *     → window.dispatchEvent("eliza:fused-wake")      (the renderer seam)
 *     → wakeControllerReducer(head-fired)             (the shipped UI controller)
 *     → WakeDetection{ path: "head-fast-path" }       (= the bottom bar opens + a turn starts)
 *
 * Every link is the real shipped code; only the cross-process transport is
 * collapsed into one process (the `eliza:fused-wake` window CustomEvent is the
 * identical seam used in production and in the jsdom unit test). Runs on this
 * macOS Apple-Silicon host — no mocks, no stubs.
 *
 *   # build the native lib once:
 *   cmake -B packages/native/plugins/wakeword-cpp/build -S packages/native/plugins/wakeword-cpp
 *   cmake --build packages/native/plugins/wakeword-cpp/build -j
 *   # then (GGUFs auto-download + sha-verify if WAKE_GGUF_DIR is unset):
 *   bun .github/issue-evidence/10351-fused-wake-bridge/validate-fused-wake-e2e.mjs
 *
 * Env overrides: WAKE_LIB, WAKE_GGUF_DIR, WAKE_POS_CLIP, WAKE_NEG_CLIP.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const HERE = fileURLToPath(new URL(".", import.meta.url));

// ── Real shipped modules (imported from source by absolute path) ────────────
const { OpenWakeWordGgmlModel } = await import(
  `${REPO}/plugins/plugin-local-inference/src/services/voice/wake-word-ggml.ts`
);
const { OpenWakeWordDetector } = await import(
  `${REPO}/plugins/plugin-local-inference/src/services/voice/wake-word.ts`
);
const { bridgeDetectorToFusedWake } = await import(
  `${REPO}/plugins/plugin-local-inference/src/services/voice/fused-wake-bridge.ts`
);
const { FUSED_WAKE_EVENT } = await import(
  `${REPO}/packages/shared/src/events/index.ts`
);
const { initialWakeControllerState, selectWakePath, wakeControllerReducer } =
  await import(`${REPO}/packages/ui/src/voice/wake-controller.ts`);

// ── The renderer seam: a real EventTarget window (== emit/subscribeFusedWake) ─
const win = new EventTarget();
const sink = (event) =>
  win.dispatchEvent(new CustomEvent(FUSED_WAKE_EVENT, { detail: event }));

const WAKE_CONFIG = {
  characterName: "eliza",
  trainedHeads: new Set(["eliza"]),
  capabilities: { openWakeWord: true, asrConfirm: true, swabble: false },
};

// The renderer's useWakeController routes each fused stage through the pure
// reducer; we mirror that here and record the confirmed WakeDetection (the
// signal that opens the bar in useWakeListenWindow).
let controllerState = initialWakeControllerState();
const detections = [];
win.addEventListener(FUSED_WAKE_EVENT, (e) => {
  const detail = e.detail;
  const event =
    detail.stage === "head-fired"
      ? { type: "head-fired", confidence: detail.confidence, now: Date.now() }
      : detail.stage === "stage-a-candidate"
        ? { type: "stage-a-candidate", now: Date.now() }
        : {
            type: "stage-b-transcript",
            transcript: detail.transcript ?? "",
            now: Date.now(),
          };
  const step = wakeControllerReducer(controllerState, event, WAKE_CONFIG);
  controllerState = step.state;
  if (step.emit) detections.push(step.emit);
});

// ── Resolve native artifacts ────────────────────────────────────────────────
const LIB =
  process.env.WAKE_LIB ??
  `${REPO}/packages/native/plugins/wakeword-cpp/build/libwakeword.dylib`;
if (!existsSync(LIB)) {
  console.error(
    `[fused-wake-e2e] missing native lib: ${LIB}\n` +
      "  build it: cmake -B packages/native/plugins/wakeword-cpp/build -S packages/native/plugins/wakeword-cpp && cmake --build packages/native/plugins/wakeword-cpp/build -j",
  );
  process.exit(2);
}

// hey-eliza wakeword head v0.3.0 — pinned in @elizaos/shared VOICE_MODEL_VERSIONS.
const HF =
  "https://huggingface.co/elizaos/eliza-1/resolve/c544bb4c78a601a0da8372b9399dfe668fbadb1e/voice/wakeword";
const GGUFS = [
  [
    "hey-eliza.melspec.gguf",
    "98bd2d5e3cc09e416626cd1a6a758cb92bb8096766d25ecf57d4c99927db682d",
  ],
  [
    "hey-eliza.embedding.gguf",
    "9cfcb0d9f1939c68cc9e63f5ac9e0f09b8e8568ee1085dbb50e7391e874a1dc5",
  ],
  [
    "hey-eliza.classifier.gguf",
    "4502c92664b18d598753114f09925921ddd065d72871607c3a842fa70510a350",
  ],
];
const GGUF_DIR = process.env.WAKE_GGUF_DIR ?? `${HERE}.gguf-cache`;
mkdirSync(GGUF_DIR, { recursive: true });
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
for (const [name, want] of GGUFS) {
  const dest = `${GGUF_DIR}/${name}`;
  if (existsSync(dest) && sha256(readFileSync(dest)) === want) continue;
  console.log(`[fused-wake-e2e] fetching ${name} …`);
  const res = await fetch(`${HF}/${name}`);
  if (!res.ok) {
    console.error(
      `[fused-wake-e2e] download failed for ${name}: ${res.status}`,
    );
    process.exit(2);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== want) {
    console.error(
      `[fused-wake-e2e] sha mismatch for ${name}: ${got} != ${want}`,
    );
    process.exit(2);
  }
  writeFileSync(dest, buf);
}

const POS = process.env.WAKE_POS_CLIP ?? `${HERE}hey-eliza-16k-mono.f32`;
const NEG =
  process.env.WAKE_NEG_CLIP ?? `${HERE}negative-what-time-16k-mono.f32`;

// ── Drive the real native runtime through the real bridge + controller ──────
async function run(clip) {
  const model = await OpenWakeWordGgmlModel.load({
    libraryPath: LIB,
    paths: {
      melspec: `${GGUF_DIR}/hey-eliza.melspec.gguf`,
      embedding: `${GGUF_DIR}/hey-eliza.embedding.gguf`,
      classifier: `${GGUF_DIR}/hey-eliza.classifier.gguf`,
    },
    config: { threshold: 0.5 },
  });
  // Wrap the real model to record the peak P(wake) for the report without
  // double-scoring (pushFrame already calls scoreFrame once per frame).
  let peak = 0;
  const recording = {
    frameSamples: model.frameSamples,
    sampleRate: model.sampleRate,
    async scoreFrame(frame) {
      const p = await model.scoreFrame(frame);
      if (p > peak) peak = p;
      return p;
    },
    reset: () => model.reset(),
  };
  // minActivationFrames=1: the C runtime already sustains internally; the clip
  // is a single utterance, so one over-threshold frame is a real detection.
  const detector = new OpenWakeWordDetector({
    model: recording,
    config: { threshold: 0.5, minActivationFrames: 1, refractoryFrames: 50 },
    onWake: bridgeDetectorToFusedWake(sink),
  });
  const f32 = new Float32Array(readFileSync(clip).buffer);
  const need = model.frameSamples;
  for (let off = 0; off + need <= f32.length; off += need) {
    await detector.pushFrame(f32.subarray(off, off + need));
  }
  model.close();
  return peak;
}

console.log("backend:", "native-cpu (real libwakeword.dylib via bun:ffi)");
console.log("lib:    ", LIB);
console.log(
  "path:   ",
  selectWakePath(WAKE_CONFIG),
  "(name=eliza, head shipped)\n",
);

let pass = 0;
let total = 0;

// Case 1: real "hey eliza" → must fire → bar opens.
total++;
controllerState = initialWakeControllerState();
detections.length = 0;
const posPeak = await run(POS);
const fired = detections.length > 0;
const detection = detections[0];
const ok1 = fired && detection?.path === "head-fast-path";
if (ok1) pass++;
console.log(`${ok1 ? "✅ PASS" : "❌ FAIL"}  POSITIVE "hey eliza"`);
console.log(`   native peak P(wake) = ${posPeak.toFixed(4)}`);
console.log(
  `   eliza:fused-wake fired=${fired}  controller emit=${detection ? `{path:${detection.path}, wakeWord:${detection.wakeWord}, confidence:${detection.confidence?.toFixed(3)}}` : "none"}`,
);
console.log(
  `   → bottom bar would OPEN + start a turn (useWakeListenWindow {type:"wake"})\n`,
);

// Case 2: a non-wake phrase → must NOT fire.
total++;
controllerState = initialWakeControllerState();
detections.length = 0;
const negPeak = await run(NEG);
const ok2 = detections.length === 0;
if (ok2) pass++;
console.log(`${ok2 ? "✅ PASS" : "❌ FAIL"}  NEGATIVE "what time is it"`);
console.log(`   native peak P(wake) = ${negPeak.toFixed(4)}`);
console.log(
  `   eliza:fused-wake fired=${detections.length > 0} (expected false)\n`,
);

console.log(`=== ${pass}/${total} fused-wake e2e cases passed ===`);
process.exit(pass === total ? 0 : 1);
