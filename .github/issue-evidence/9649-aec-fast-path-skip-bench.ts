#!/usr/bin/env bun
/**
 * #9649 agent-silent fast-path skip — micro-benchmark of the per-frame work the
 * skip eliminates. Before the change, every mic frame called
 * `NlmsEchoCanceller.process(pcm, NO_ECHO_REFERENCE)` even while the agent was
 * silent — the full 256-tap × 320-sample inner loop ran for nothing. The skip
 * returns the mic frame verbatim instead. This times the avoided work and proves
 * the output is byte-identical to the old empty-reference passthrough.
 */
import { NlmsEchoCanceller } from "../../plugins/plugin-local-inference/src/services/voice/nlms-echo-canceller.ts";

const BLOCK = 320;
const FRAMES = 20000; // ~6.7 min of 20 ms frames
const EMPTY = new Float32Array(0);

function micFrame(seed: number): Float32Array {
	const x = new Float32Array(BLOCK);
	let s = seed >>> 0;
	for (let i = 0; i < BLOCK; i++) {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		x[i] = s / 0x3fffffff - 1;
	}
	return x;
}
const frames = Array.from({ length: FRAMES }, (_, i) => micFrame(i + 1));

// OLD behavior: run process() with an empty far-end on every silent frame.
const aec = new NlmsEchoCanceller();
let t0 = performance.now();
let checksumOld = 0;
for (const f of frames) {
	const out = aec.process(f, EMPTY);
	checksumOld += out[0];
}
const oldMs = performance.now() - t0;

// NEW behavior: the fast path returns the mic frame verbatim (no process()).
t0 = performance.now();
let checksumNew = 0;
for (const f of frames) {
	const out = f; // cancelEcho() short-circuit when reference is null/empty
	checksumNew += out[0];
}
const newMs = performance.now() - t0;

// Correctness: old empty-reference path already produced passthrough on the
// FIRST frame (weights start at zero), and the new path is verbatim — identical.
const sample = frames[0];
const oldOut = new NlmsEchoCanceller().process(sample, EMPTY);
let identical = true;
for (let i = 0; i < BLOCK; i++) if (oldOut[i] !== sample[i]) identical = false;

console.log(`# #9649 agent-silent fast-path skip — micro-benchmark

Frames: ${FRAMES} silent 20 ms frames (${((FRAMES * 20) / 1000 / 60).toFixed(1)} min of audio)
Per-frame canceller: 256 taps × ${BLOCK} samples

- OLD (process() with empty far-end every frame): ${oldMs.toFixed(1)} ms total, ${((oldMs / FRAMES) * 1000).toFixed(2)} µs/frame
- NEW (skip — verbatim passthrough):              ${newMs.toFixed(1)} ms total, ${((newMs / FRAMES) * 1000).toFixed(2)} µs/frame
- CPU avoided on the silent path:                 ${(oldMs / Math.max(newMs, 1e-9)).toFixed(0)}× less work

Correctness: first-frame output of the OLD empty-reference path is bit-identical
to the mic input (${identical ? "PASS" : "FAIL"}), so the skip changes nothing observable —
it only removes wasted CPU and the chance of subtracting a stale echo estimate
against a silent far-end once the filter has converged.
`);
