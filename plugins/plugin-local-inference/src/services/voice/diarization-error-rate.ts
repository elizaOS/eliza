// Diarization Error Rate (DER) scorer for the voice test matrix (issue #9147).
//
// The voice-scenario schema already carries a `maxDer` threshold and an
// `expectedSpeakerLabel` per turn, but nothing computed DER — diarization was
// only ever scored on the respond-decision, so a wrong speaker attribution or a
// missed overlapping talker passed silently. This is that missing scorer: a
// pure, frame-based DER (the standard NIST md-eval decomposition) so the
// diarization / multi-speaker / overlapping-speech scenario classes can assert
// per-turn labels AND enforce `maxDer`.
//
// Frame-based (default 10ms) so OVERLAPPING speech is handled correctly: each
// frame compares the SET of reference speakers against the SET of hypothesis
// speakers, after an optimal one-to-one speaker mapping that maximizes matched
// time. Everything here is deterministic and dependency-free.

export interface DiarizationSegment {
	/** Speaker label (any stable string — ground-truth and hypothesis label
	 * spaces are mapped against each other, so the raw strings need not match). */
	speaker: string;
	/** Segment start, milliseconds. */
	startMs: number;
	/** Segment end, milliseconds (must be ≥ startMs). */
	endMs: number;
}

export interface DerResult {
	/** Diarization Error Rate: (missed + falseAlarm + confusion) / referenceMs.
	 * 0 = perfect; can exceed 1 when false alarms dominate. */
	der: number;
	/** Reference speech the system failed to attribute to anyone (ms). */
	missedMs: number;
	/** System speech with no reference speaker present (ms). */
	falseAlarmMs: number;
	/** Reference speech attributed to the wrong (mapped) speaker (ms). */
	confusionMs: number;
	/** Total reference speaker-time (Σ |ref speakers in frame| · frame), the DER denominator. */
	totalReferenceMs: number;
	/** The chosen hypothesis→reference speaker mapping (optimal for matched time). */
	mapping: Record<string, string>;
}

export interface DerOptions {
	/** Frame size in ms (default 10). Smaller = more precise, more work. */
	frameMs?: number;
	/** Above this combined speaker count, fall back to a greedy mapping instead
	 * of the exact permutation search (keeps it O(n) not O(n!)). Default 7. */
	maxExactSpeakers?: number;
}

function totalDurationMs(segments: readonly DiarizationSegment[]): number {
	return segments.reduce((max, s) => Math.max(max, s.endMs), 0);
}

/** Per-frame active-speaker sets. `frames[f]` is the set of speakers whose
 * segment covers the start of frame `f`. */
function frameize(
	segments: readonly DiarizationSegment[],
	frameMs: number,
	numFrames: number,
): Array<Set<string>> {
	const frames: Array<Set<string>> = Array.from(
		{ length: numFrames },
		() => new Set<string>(),
	);
	for (const seg of segments) {
		if (seg.endMs <= seg.startMs) continue;
		const first = Math.max(0, Math.floor(seg.startMs / frameMs));
		// A frame f (covering [f·frameMs, (f+1)·frameMs)) is active if its start
		// time falls within [startMs, endMs).
		const last = Math.min(numFrames - 1, Math.ceil(seg.endMs / frameMs) - 1);
		for (let f = first; f <= last; f++) {
			if (f * frameMs >= seg.startMs && f * frameMs < seg.endMs) {
				frames[f].add(seg.speaker);
			}
		}
	}
	return frames;
}

function uniqueSpeakers(segments: readonly DiarizationSegment[]): string[] {
	return [...new Set(segments.map((s) => s.speaker))];
}

/** Frames where reference speaker `r` and hypothesis speaker `h` are both active. */
function coOccurrence(
	refFrames: Array<Set<string>>,
	hypFrames: Array<Set<string>>,
	refSpeakers: string[],
	hypSpeakers: string[],
): Map<string, Map<string, number>> {
	const co = new Map<string, Map<string, number>>();
	for (const r of refSpeakers)
		co.set(r, new Map(hypSpeakers.map((h) => [h, 0])));
	for (let f = 0; f < refFrames.length; f++) {
		const rs = refFrames[f];
		const hs = hypFrames[f];
		if (rs.size === 0 || hs.size === 0) continue;
		for (const r of rs) {
			const row = co.get(r);
			if (!row) continue;
			for (const h of hs) row.set(h, (row.get(h) ?? 0) + 1);
		}
	}
	return co;
}

/** Optimal injective hyp→ref mapping maximizing total co-occurrence (exact for
 * small speaker counts, greedy beyond `maxExactSpeakers`). */
function bestMapping(
	co: Map<string, Map<string, number>>,
	refSpeakers: string[],
	hypSpeakers: string[],
	maxExact: number,
): Record<string, string> {
	const score = (h: string, r: string) => co.get(r)?.get(h) ?? 0;

	if (refSpeakers.length + hypSpeakers.length <= maxExact) {
		// Exact: try every injective assignment of hyp speakers onto ref speakers.
		let best: Record<string, string> = {};
		let bestScore = -1;
		const assign = (
			i: number,
			usedRefs: Set<string>,
			current: Record<string, string>,
			running: number,
		) => {
			if (i === hypSpeakers.length) {
				if (running > bestScore) {
					bestScore = running;
					best = { ...current };
				}
				return;
			}
			const h = hypSpeakers[i];
			// Option: leave this hypothesis speaker unmapped (pure false alarm).
			assign(i + 1, usedRefs, current, running);
			for (const r of refSpeakers) {
				if (usedRefs.has(r)) continue;
				usedRefs.add(r);
				current[h] = r;
				assign(i + 1, usedRefs, current, running + score(h, r));
				delete current[h];
				usedRefs.delete(r);
			}
		};
		assign(0, new Set(), {}, 0);
		return best;
	}

	// Greedy: repeatedly take the highest-scoring (h, r) pair not yet used.
	const pairs: Array<{ h: string; r: string; s: number }> = [];
	for (const h of hypSpeakers) {
		for (const r of refSpeakers) pairs.push({ h, r, s: score(h, r) });
	}
	pairs.sort((a, b) => b.s - a.s);
	const usedHyp = new Set<string>();
	const usedRef = new Set<string>();
	const mapping: Record<string, string> = {};
	for (const { h, r, s } of pairs) {
		if (s <= 0 || usedHyp.has(h) || usedRef.has(r)) continue;
		mapping[h] = r;
		usedHyp.add(h);
		usedRef.add(r);
	}
	return mapping;
}

/**
 * Frame-based Diarization Error Rate between a reference (ground-truth) speaker
 * timeline and a hypothesis (diarizer output) timeline. Returns DER plus its
 * missed / false-alarm / confusion decomposition and the speaker mapping used.
 */
export function computeDiarizationErrorRate(
	reference: readonly DiarizationSegment[],
	hypothesis: readonly DiarizationSegment[],
	options: DerOptions = {},
): DerResult {
	const frameMs = options.frameMs && options.frameMs > 0 ? options.frameMs : 10;
	const maxExact = options.maxExactSpeakers ?? 7;
	const durationMs = Math.max(
		totalDurationMs(reference),
		totalDurationMs(hypothesis),
	);
	const numFrames = Math.ceil(durationMs / frameMs);

	const refSpeakers = uniqueSpeakers(reference);
	const hypSpeakers = uniqueSpeakers(hypothesis);
	const refFrames = frameize(reference, frameMs, numFrames);
	const hypFrames = frameize(hypothesis, frameMs, numFrames);

	const co = coOccurrence(refFrames, hypFrames, refSpeakers, hypSpeakers);
	const mapping = bestMapping(co, refSpeakers, hypSpeakers, maxExact);
	// inverse: ref speaker -> the hyp speaker mapped onto it.
	const inverse = new Map<string, string>();
	for (const [h, r] of Object.entries(mapping)) inverse.set(r, h);

	let missedFrames = 0;
	let falseAlarmFrames = 0;
	let confusionFrames = 0;
	let referenceSpeakerFrames = 0;

	for (let f = 0; f < numFrames; f++) {
		const R = refFrames[f];
		const H = hypFrames[f];
		const nRef = R.size;
		const nSys = H.size;
		referenceSpeakerFrames += nRef;
		if (nRef === 0 && nSys === 0) continue;

		// Correctly attributed: a ref speaker whose mapped hyp speaker is active.
		let correct = 0;
		for (const r of R) {
			const h = inverse.get(r);
			if (h !== undefined && H.has(h)) correct += 1;
		}

		missedFrames += Math.max(0, nRef - nSys);
		falseAlarmFrames += Math.max(0, nSys - nRef);
		confusionFrames += Math.min(nRef, nSys) - correct;
	}

	const missedMs = missedFrames * frameMs;
	const falseAlarmMs = falseAlarmFrames * frameMs;
	const confusionMs = confusionFrames * frameMs;
	const totalReferenceMs = referenceSpeakerFrames * frameMs;
	const der =
		totalReferenceMs > 0
			? (missedMs + falseAlarmMs + confusionMs) / totalReferenceMs
			: falseAlarmMs > 0
				? Number.POSITIVE_INFINITY
				: 0;

	return {
		der,
		missedMs,
		falseAlarmMs,
		confusionMs,
		totalReferenceMs,
		mapping,
	};
}

/** Whether a diarization hypothesis is within a scenario's `maxDer` budget. */
export function diarizationWithinBudget(
	result: Pick<DerResult, "der">,
	maxDer: number,
): boolean {
	return result.der <= maxDer;
}
