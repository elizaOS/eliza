/**
 * #11373 — offline ERLE / delay / double-talk measurement over a REAL device
 * capture pulled from the on-device AEC loop harness
 * (`packages/ui/src/voice/aec-loop-harness.ts` → Documents/eliza-aec-loop-result.json).
 *
 * No mocks of the subject: the near/far PCM was captured ON the device by the
 * production `LiveDiarizationSession` (via `POST /api/voice/aec-capture`), and
 * this tool replays it through the PRODUCTION `EchoReferenceBuffer` +
 * `NlmsEchoCanceller` + `computeErle` + `estimateEchoDelaySamples` — the exact
 * classes the live path runs — the same Phase-C methodology as the accepted
 * macOS bundle (`.github/issue-evidence/9583-aec-macos/`).
 *
 * The AEC-off baseline is the raw mic signal itself (no processing ⇒ 0 dB
 * ERLE by definition); "AEC on" is the replayed canceller output.
 *
 * Run (bun, from the repo root):
 *   bun .github/issue-evidence/9583-aec-device-loops/driver/measure-device-erle.ts \
 *     --input <eliza-aec-loop-result.json> --out <dir> [--label ios-mooncycles]
 *     [--source agent|page]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const { estimateEchoDelaySamples } = await import(
	path.join(VOICE, "echo-delay.ts")
);

const SR = 16_000;
const FRAME = 320;

const argvArg = (name: string): string | undefined => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const INPUT = argvArg("--input");
const OUT = path.resolve(argvArg("--out") ?? ".");
const LABEL = argvArg("--label") ?? "device";
const SOURCE = argvArg("--source") ?? "agent";
if (!INPUT) throw new Error("--input <eliza-aec-loop-result.json> required");
mkdirSync(OUT, { recursive: true });

function decodePcm16(b64: string): Float32Array {
	const buf = Buffer.from(b64, "base64");
	const out = new Float32Array(buf.length >> 1);
	for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
	return out;
}

function writeWav(file: string, pcm: Float32Array): void {
	const data = Buffer.alloc(pcm.length * 2);
	for (let i = 0; i < pcm.length; i++) {
		const v = Math.max(-1, Math.min(1, pcm[i]));
		data.writeInt16LE(Math.round(v * 32767), i * 2);
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(SR, 24);
	header.writeUInt32LE(SR * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	writeFileSync(file, Buffer.concat([header, data]));
}

function rms(pcm: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
	return Math.sqrt(sum / Math.max(1, pcm.length));
}

interface MeasureOutcome {
	erleOverallDb: number;
	erleConvergedHalfDb: number;
	perSecondErleDb: number[];
	framesCancelled: number;
	framesPassthrough: number;
	residual: Float32Array;
}

/** Replay the production buffer+canceller exactly the way the live session
 * drives them (same referenceAt(delay) read, same far-silence passthrough). */
function measure(
	near: Float32Array,
	far: Float32Array,
	delaySamples: number,
	residualSuppression: boolean,
): MeasureOutcome {
	const buffer = new EchoReferenceBuffer();
	const canceller = new NlmsEchoCanceller(
		residualSuppression ? { residualSuppression: true } : {},
	);
	const nearActive: Float32Array[] = [];
	const residActive: Float32Array[] = [];
	const residual = new Float32Array(near.length);
	const perSec: { near: number; resid: number }[] = [];
	let cancelled = 0;
	let passthrough = 0;
	for (let i = 0; i + FRAME <= near.length; i += FRAME) {
		const ts = (i / SR) * 1000;
		buffer.pushAt(ts, far.subarray(i, i + FRAME));
		const nearFrame = near.subarray(i, i + FRAME);
		const ref = buffer.referenceAt(ts, FRAME, delaySamples);
		let refEnergy = 0;
		for (let j = 0; j < FRAME; j++) refEnergy += ref[j] * ref[j];
		if (refEnergy / FRAME < 1e-7) {
			canceller.observeFarEndSilence(nearFrame);
			residual.set(nearFrame, i);
			passthrough++;
			continue;
		}
		const out = canceller.process(nearFrame, ref);
		residual.set(out, i);
		cancelled++;
		nearActive.push(nearFrame.slice());
		residActive.push(out.slice());
		const sec = Math.floor(ts / 1000);
		while (perSec.length <= sec) perSec.push({ near: 0, resid: 0 });
		for (let j = 0; j < FRAME; j++) {
			perSec[sec].near += nearFrame[j] * nearFrame[j];
			perSec[sec].resid += out[j] * out[j];
		}
	}
	const cat = (chunks: Float32Array[]) => {
		const n = chunks.reduce((a, c) => a + c.length, 0);
		const merged = new Float32Array(n);
		let o = 0;
		for (const c of chunks) {
			merged.set(c, o);
			o += c.length;
		}
		return merged;
	};
	const nearCat = cat(nearActive);
	const residCat = cat(residActive);
	const half = nearCat.length >> 1;
	return {
		erleOverallDb: computeErle(nearCat, residCat),
		erleConvergedHalfDb: computeErle(
			nearCat.subarray(half),
			residCat.subarray(half),
		),
		perSecondErleDb: perSec.map((s) =>
			s.near > 0 && s.resid > 0 ? 10 * Math.log10(s.near / s.resid) : 0,
		),
		framesCancelled: cancelled,
		framesPassthrough: passthrough,
		residual,
	};
}

// ── Load the device result ─────────────────────────────────────────────────
const raw = JSON.parse(readFileSync(INPUT, "utf8"));
const capture = raw.aecCapture?.capture ?? raw.aecCapture ?? null;

let near: Float32Array;
let far: Float32Array;
let sourceUsed: string;
if (
	SOURCE === "agent" &&
	capture &&
	typeof capture.nearPcm16 === "string" &&
	capture.nearPcm16.length > 0
) {
	near = decodePcm16(capture.nearPcm16);
	far = decodePcm16(capture.farPcm16);
	sourceUsed = "agent aec-capture snapshot (production session buffers)";
} else if (typeof raw.pageMicPcm16 === "string" && raw.pageMicPcm16.length) {
	near = decodePcm16(raw.pageMicPcm16);
	far = decodePcm16(raw.pagePlayPcm16 ?? "");
	sourceUsed = "page-side PCM copies (WebView tap buffers)";
} else {
	throw new Error("no PCM in result JSON (agent capture empty, no page copy)");
}

console.log(
	`[load] ${LABEL}: near=${(near.length / SR).toFixed(1)}s (rms ${rms(near).toFixed(4)}) far=${(far.length / SR).toFixed(1)}s (rms ${rms(far).toFixed(4)}) source=${sourceUsed}`,
);
if (rms(far) < 1e-5) {
	console.warn(
		"[warn] far-end is (near-)silent — playback frames likely never reached the capture; ERLE below is meaningless",
	);
}

// ── Delay: production estimator over the whole window + device-side value ──
const est = estimateEchoDelaySamples(near, far, { maxLagSamples: 8_000 });
const deviceDelay = {
	echoDelaySamples: capture?.echoDelaySamples ?? null,
	echoDelayConfidence: capture?.echoDelayConfidence ?? null,
	echoDelayCalibrated: capture?.echoDelayCalibrated ?? null,
};
console.log(
	`[delay] offline production estimator: ${est.lagSamples} samples (${((est.lagSamples / SR) * 1000).toFixed(1)} ms) confidence=${est.confidence.toFixed(3)}`,
);
console.log(
	`[delay] device self-calibration: ${JSON.stringify(deviceDelay)} (${deviceDelay.echoDelaySamples != null ? ((deviceDelay.echoDelaySamples / SR) * 1000).toFixed(1) : "?"} ms)`,
);

const delayForMeasure =
	deviceDelay.echoDelayCalibrated && deviceDelay.echoDelaySamples != null
		? deviceDelay.echoDelaySamples
		: est.lagSamples;

// ── ERLE: AEC off (raw) vs on (production replay) ──────────────────────────
const linear = measure(near, far, delayForMeasure, false);
const suppressed = measure(near, far, delayForMeasure, true);
console.log(
	`[erle] AEC OFF baseline: 0.00 dB by definition (raw mic passthrough)`,
);
console.log(
	`[erle] AEC ON  linear NLMS: overall=${linear.erleOverallDb.toFixed(2)} dB converged-half=${linear.erleConvergedHalfDb.toFixed(2)} dB (cancelled=${linear.framesCancelled} passthrough=${linear.framesPassthrough})`,
);
console.log(
	`[erle] AEC ON  +residual suppression: overall=${suppressed.erleOverallDb.toFixed(2)} dB converged-half=${suppressed.erleConvergedHalfDb.toFixed(2)} dB`,
);

// ── Artifacts ──────────────────────────────────────────────────────────────
writeWav(path.join(OUT, `${LABEL}-near-mic.wav`), near);
writeWav(path.join(OUT, `${LABEL}-far-reference.wav`), far);
writeWav(path.join(OUT, `${LABEL}-residual-linear.wav`), linear.residual);
writeWav(
	path.join(OUT, `${LABEL}-residual-suppressed.wav`),
	suppressed.residual,
);

const report = {
	issue: 11373,
	label: LABEL,
	input: path.resolve(INPUT),
	sourceUsed,
	sampleRateHz: SR,
	frameSamples: FRAME,
	nearSeconds: near.length / SR,
	nearRms: rms(near),
	farRms: rms(far),
	tag: raw.tag ?? null,
	deviceStatusBefore: raw.statusBefore ?? null,
	deviceStatusAfter: raw.statusAfter ?? null,
	deviceTrackSettings: raw.trackSettings ?? null,
	deviceContextSampleRate: raw.contextSampleRate ?? null,
	offlineDelayEstimate: {
		lagSamples: est.lagSamples,
		lagMs: (est.lagSamples / SR) * 1000,
		confidence: est.confidence,
	},
	deviceDelaySelfCalibration: deviceDelay,
	delaySamplesUsed: delayForMeasure,
	erle: {
		aecOffBaselineDb: 0,
		linear: {
			erleOverallDb: linear.erleOverallDb,
			erleConvergedHalfDb: linear.erleConvergedHalfDb,
			perSecondErleDb: linear.perSecondErleDb,
			framesCancelled: linear.framesCancelled,
			framesPassthrough: linear.framesPassthrough,
		},
		residualSuppression: {
			erleOverallDb: suppressed.erleOverallDb,
			erleConvergedHalfDb: suppressed.erleConvergedHalfDb,
			perSecondErleDb: suppressed.perSecondErleDb,
		},
	},
};
const reportPath = path.join(OUT, `${LABEL}-erle-report.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`[done] wrote ${reportPath}`);
