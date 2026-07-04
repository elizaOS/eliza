/**
 * ERLE metrics for the voice pipeline. The math is canonical in
 * `@elizaos/shared/voice/aec`; this module re-exports it and adds the
 * capture-replay helper that turns an armed AEC evidence window (#11373)
 * into an offline ERLE measurement using the exact production canceller.
 */

import {
	computeErle,
	computeFarActiveErle,
	NlmsEchoCanceller,
} from "@elizaos/shared/voice/aec";

export { computeErle, computeFarActiveErle };

/** The slice of {@link AecCaptureSnapshot} the replay needs. */
export interface AecCaptureReplayInput {
	/** Base64 LE-s16 near-end (raw mic, pre-AEC) @16 kHz. */
	nearPcm16: string;
	/** Base64 LE-s16 far-end reference read at delay 0 @16 kHz. */
	farPcm16: string;
	/** Playback→mic delay (samples) the live canceller applied. */
	echoDelaySamples: number;
}

export interface AecCaptureReplayResult {
	/** Whole-window ERLE of the replayed canceller (10·log10 near²/residual²). */
	erleDb: number;
	/** ERLE over far-active blocks only (null when the far-end was silent). */
	farActiveErleDb: number | null;
	sampleCount: number;
	farActiveSamples: number;
}

function decodePcm16Base64(b64: string): Float32Array {
	const bytes = Buffer.from(b64, "base64");
	const out = new Float32Array(bytes.length >> 1);
	for (let i = 0; i < out.length; i++) {
		out[i] = bytes.readInt16LE(i * 2) / 32_768;
	}
	return out;
}

/**
 * Replay a captured near/far window through a fresh production
 * `NlmsEchoCanceller` (applying the live delay the capture recorded) and
 * measure the resulting ERLE — the on-demand number `GET /api/voice/aec-capture`
 * and the dev telemetry surface report. Returns null when the capture holds no
 * samples: an empty window has no measurement, and fabricating one would make
 * an unwired path look healthy.
 */
export function replayAecCaptureErle(
	capture: AecCaptureReplayInput,
): AecCaptureReplayResult | null {
	const near = decodePcm16Base64(capture.nearPcm16);
	const far = decodePcm16Base64(capture.farPcm16);
	if (near.length === 0) return null;
	const canceller = new NlmsEchoCanceller({
		delaySamples: Math.max(0, Math.floor(capture.echoDelaySamples)),
	});
	const residual = canceller.process(near, far);
	const masked = computeFarActiveErle(near, residual, far);
	return {
		erleDb: computeErle(near, residual),
		farActiveErleDb: masked.erleDb,
		sampleCount: near.length,
		farActiveSamples: masked.farActiveSamples,
	};
}
