/**
 * Computes frame-based Diarization Error Rate for the voice workbench.
 * Overlapping speech is scored as active-speaker sets after a one-to-one label
 * mapping. Input, sweep, co-occurrence, and exact-search budgets bound scenario
 * data before it can exhaust the host running a benchmark.
 */

import { ElizaError } from "@elizaos/core";

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
	 * of the exact permutation search. Must be an integer from 0 through 7;
	 * larger thresholds would make the exact branch factorial. Default 7. */
	maxExactSpeakers?: number;
}

/** Smallest accepted frame. A sub-millisecond frame with a long timeline
 * would allocate tens of millions of Sets and hang the scorer. */
export const MIN_DER_FRAME_MS = 1;
/** Longest accepted reference/hypothesis timeline. Voice scenarios are
 * minutes; this also rejects nonsensical timestamp magnitudes early. */
export const MAX_DER_DURATION_MS = 4 * 60 * 60 * 1000;
/** Maximum frames swept by one score. At the default 10ms resolution this
 * still admits the full four-hour timeline. */
export const MAX_DER_FRAMES = 1_500_000;
/** Maximum combined reference and hypothesis segments. */
export const MAX_DER_SEGMENTS = 100_000;
/** Maximum combined distinct labels used to size the mapping matrix. */
export const MAX_DER_SPEAKERS = 256;
/** Maximum frame/pair visits across co-occurrence and final scoring sweeps. */
export const MAX_DER_WORK_UNITS = 10_000_000;
/** Maximum safe threshold for the factorial exact mapping branch. */
export const MAX_DER_EXACT_SPEAKERS = 7;
/** Speaker identifiers are labels, not an unbounded text-retention surface. */
export const MAX_DER_SPEAKER_LABEL_CHARS = 256;

interface ValidatedTimeline {
	durationMs: number;
	speakers: Set<string>;
}

function invalidDiarizationInput(
	message: string,
	context?: Record<string, unknown>,
): ElizaError {
	return new ElizaError(message, {
		code: "DIARIZATION_INPUT_INVALID",
		context,
		severity: "ephemeral",
	});
}

function unboundedDiarizationScore(
	message: string,
	context: Record<string, unknown>,
): ElizaError {
	return new ElizaError(message, {
		code: "DIARIZATION_SCORE_UNBOUNDED",
		context,
		severity: "ephemeral",
	});
}

function validateTimeline(
	segments: readonly DiarizationSegment[],
	name: string,
): ValidatedTimeline {
	if (!Array.isArray(segments)) {
		throw invalidDiarizationInput(
			`Diarization ${name} must be an array of segments`,
			{ timeline: name },
		);
	}
	let max = 0;
	const speakers = new Set<string>();
	for (let index = 0; index < segments.length; index++) {
		const s = segments[index];
		if (s === null || typeof s !== "object") {
			throw invalidDiarizationInput(
				`Diarization ${name}[${index}] must be a segment object`,
				{ timeline: name, index },
			);
		}
		if (!Number.isFinite(s.startMs) || !Number.isFinite(s.endMs)) {
			throw invalidDiarizationInput(
				"Diarization segment startMs/endMs must be finite milliseconds",
				{ timeline: name, index },
			);
		}
		if (s.startMs < 0 || s.endMs < 0) {
			throw invalidDiarizationInput(
				"Diarization segment startMs/endMs must be non-negative",
				{ timeline: name, index },
			);
		}
		if (s.endMs < s.startMs) {
			throw invalidDiarizationInput(
				"Diarization segment endMs must be greater than or equal to startMs",
				{ timeline: name, index },
			);
		}
		if (
			typeof s.speaker !== "string" ||
			s.speaker.length > MAX_DER_SPEAKER_LABEL_CHARS
		) {
			throw invalidDiarizationInput(
				`Diarization speaker labels must be strings of at most ${MAX_DER_SPEAKER_LABEL_CHARS} characters`,
				{ timeline: name, index, limit: MAX_DER_SPEAKER_LABEL_CHARS },
			);
		}
		speakers.add(s.speaker);
		if (s.endMs > max) max = s.endMs;
	}
	return { durationMs: max, speakers };
}

interface FrameEvents {
	add: string[];
	remove: string[];
}

/** Build sparse activation events rather than allocating one Set per frame. */
function buildFrameEvents(
	segments: readonly DiarizationSegment[],
	frameMs: number,
	numFrames: number,
): Map<number, FrameEvents> {
	const events = new Map<number, FrameEvents>();
	const eventAt = (frame: number): FrameEvents => {
		let event = events.get(frame);
		if (!event) {
			event = { add: [], remove: [] };
			events.set(frame, event);
		}
		return event;
	};
	for (const seg of segments) {
		if (seg.endMs <= seg.startMs) continue;
		const first = Math.ceil(seg.startMs / frameMs);
		const afterLast = Math.min(numFrames, Math.ceil(seg.endMs / frameMs));
		if (first >= afterLast) continue;
		eventAt(first).add.push(seg.speaker);
		eventAt(afterLast).remove.push(seg.speaker);
	}
	return events;
}

type ActiveSpeakers = Map<string, number>;

function applyFrameEvents(active: ActiveSpeakers, event?: FrameEvents): void {
	if (!event) return;
	for (const speaker of event.remove) {
		const count = active.get(speaker) ?? 0;
		if (count <= 1) active.delete(speaker);
		else active.set(speaker, count - 1);
	}
	for (const speaker of event.add) {
		active.set(speaker, (active.get(speaker) ?? 0) + 1);
	}
}

/** Frames where reference speaker `r` and hypothesis speaker `h` are both active. */
function coOccurrence(
	refEvents: Map<number, FrameEvents>,
	hypEvents: Map<number, FrameEvents>,
	numFrames: number,
	refSpeakers: string[],
	hypSpeakers: string[],
	consumeWork: (amount: number) => void,
): Map<string, Map<string, number>> {
	const co = new Map<string, Map<string, number>>();
	for (const r of refSpeakers)
		co.set(r, new Map(hypSpeakers.map((h) => [h, 0])));
	const rs: ActiveSpeakers = new Map();
	const hs: ActiveSpeakers = new Map();
	for (let f = 0; f < numFrames; f++) {
		applyFrameEvents(rs, refEvents.get(f));
		applyFrameEvents(hs, hypEvents.get(f));
		consumeWork(1 + rs.size * hs.size);
		if (rs.size === 0 || hs.size === 0) continue;
		for (const r of rs.keys()) {
			const row = co.get(r);
			if (!row) continue;
			for (const h of hs.keys()) row.set(h, (row.get(h) ?? 0) + 1);
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
		let best = new Map<string, string>();
		let bestScore = -1;
		const assign = (
			i: number,
			usedRefs: Set<string>,
			current: Map<string, string>,
			running: number,
		) => {
			if (i === hypSpeakers.length) {
				if (running > bestScore) {
					bestScore = running;
					best = new Map(current);
				}
				return;
			}
			const h = hypSpeakers[i];
			// Option: leave this hypothesis speaker unmapped (pure false alarm).
			assign(i + 1, usedRefs, current, running);
			for (const r of refSpeakers) {
				if (usedRefs.has(r)) continue;
				usedRefs.add(r);
				current.set(h, r);
				assign(i + 1, usedRefs, current, running + score(h, r));
				current.delete(h);
				usedRefs.delete(r);
			}
		};
		assign(0, new Set(), new Map(), 0);
		return Object.fromEntries(best);
	}

	// Greedy: repeatedly take the highest-scoring (h, r) pair not yet used.
	const pairs: Array<{ h: string; r: string; s: number }> = [];
	for (const h of hypSpeakers) {
		for (const r of refSpeakers) pairs.push({ h, r, s: score(h, r) });
	}
	pairs.sort((a, b) => b.s - a.s);
	const usedHyp = new Set<string>();
	const usedRef = new Set<string>();
	const mapping = new Map<string, string>();
	for (const { h, r, s } of pairs) {
		if (s <= 0 || usedHyp.has(h) || usedRef.has(r)) continue;
		mapping.set(h, r);
		usedHyp.add(h);
		usedRef.add(r);
	}
	return Object.fromEntries(mapping);
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
	const requestedFrame = options.frameMs;
	const frameMs = requestedFrame ?? 10;
	if (!Number.isFinite(frameMs) || frameMs < MIN_DER_FRAME_MS) {
		throw invalidDiarizationInput(
			`Diarization frameMs must be a finite value ≥ ${MIN_DER_FRAME_MS}ms`,
			{ frameMs, minimum: MIN_DER_FRAME_MS },
		);
	}
	const maxExact = options.maxExactSpeakers ?? 7;
	if (
		!Number.isSafeInteger(maxExact) ||
		maxExact < 0 ||
		maxExact > MAX_DER_EXACT_SPEAKERS
	) {
		throw invalidDiarizationInput(
			`Diarization maxExactSpeakers must be an integer from 0 through ${MAX_DER_EXACT_SPEAKERS}`,
			{ maxExactSpeakers: maxExact, maximum: MAX_DER_EXACT_SPEAKERS },
		);
	}
	if (!Array.isArray(reference) || !Array.isArray(hypothesis)) {
		throw invalidDiarizationInput(
			"Diarization reference and hypothesis must be segment arrays",
		);
	}
	if (
		reference.length > MAX_DER_SEGMENTS ||
		hypothesis.length > MAX_DER_SEGMENTS - reference.length
	) {
		throw unboundedDiarizationScore(
			`Diarization input exceeds ${MAX_DER_SEGMENTS} combined segments`,
			{
				limit: MAX_DER_SEGMENTS,
				referenceSegments: reference.length,
				hypothesisSegments: hypothesis.length,
			},
		);
	}
	const validatedReference = validateTimeline(reference, "reference");
	const validatedHypothesis = validateTimeline(hypothesis, "hypothesis");
	const durationMs = Math.max(
		validatedReference.durationMs,
		validatedHypothesis.durationMs,
	);
	if (durationMs > MAX_DER_DURATION_MS) {
		throw unboundedDiarizationScore(
			`Diarization timeline ${durationMs}ms exceeds ${MAX_DER_DURATION_MS}ms`,
			{ durationMs, limit: MAX_DER_DURATION_MS },
		);
	}
	const numFrames = Math.ceil(durationMs / frameMs);
	if (!Number.isSafeInteger(numFrames) || numFrames > MAX_DER_FRAMES) {
		throw unboundedDiarizationScore(
			`Diarization score exceeds ${MAX_DER_FRAMES} frames at ${frameMs}ms resolution`,
			{ frames: numFrames, limit: MAX_DER_FRAMES, frameMs },
		);
	}

	const refSpeakers = [...validatedReference.speakers];
	const hypSpeakers = [...validatedHypothesis.speakers];
	if (refSpeakers.length + hypSpeakers.length > MAX_DER_SPEAKERS) {
		throw unboundedDiarizationScore(
			`Diarization input exceeds ${MAX_DER_SPEAKERS} combined speakers`,
			{
				limit: MAX_DER_SPEAKERS,
				referenceSpeakers: refSpeakers.length,
				hypothesisSpeakers: hypSpeakers.length,
			},
		);
	}
	const refEvents = buildFrameEvents(reference, frameMs, numFrames);
	const hypEvents = buildFrameEvents(hypothesis, frameMs, numFrames);
	let remainingWork = MAX_DER_WORK_UNITS;
	const consumeWork = (amount: number): void => {
		if (amount > remainingWork) {
			throw unboundedDiarizationScore(
				`Diarization score exceeds ${MAX_DER_WORK_UNITS} bounded work units`,
				{ limit: MAX_DER_WORK_UNITS },
			);
		}
		remainingWork -= amount;
	};

	const co = coOccurrence(
		refEvents,
		hypEvents,
		numFrames,
		refSpeakers,
		hypSpeakers,
		consumeWork,
	);
	const mapping = bestMapping(co, refSpeakers, hypSpeakers, maxExact);
	// inverse: ref speaker -> the hyp speaker mapped onto it.
	const inverse = new Map<string, string>();
	for (const [h, r] of Object.entries(mapping)) inverse.set(r, h);

	let missedFrames = 0;
	let falseAlarmFrames = 0;
	let confusionFrames = 0;
	let referenceSpeakerFrames = 0;
	const R: ActiveSpeakers = new Map();
	const H: ActiveSpeakers = new Map();

	for (let f = 0; f < numFrames; f++) {
		applyFrameEvents(R, refEvents.get(f));
		applyFrameEvents(H, hypEvents.get(f));
		consumeWork(1 + R.size);
		const nRef = R.size;
		const nSys = H.size;
		referenceSpeakerFrames += nRef;
		if (nRef === 0 && nSys === 0) continue;

		// Correctly attributed: a ref speaker whose mapped hyp speaker is active.
		let correct = 0;
		for (const r of R.keys()) {
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
