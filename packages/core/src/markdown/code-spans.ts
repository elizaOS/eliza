/**
 * Detects backtick-delimited inline code while preserving state across streamed
 * chunks. Parsing sweeps ordered fence spans once, while arbitrary membership
 * queries use binary search, so hostile fence-heavy input remains bounded.
 */

import { type FenceSpan, parseFenceSpans } from "./fences.js";

/**
 * State for tracking open inline code spans across chunks.
 */
export type InlineCodeState = {
	/** Whether we're currently inside an inline code span */
	open: boolean;
	/** Number of backticks in the opening sequence */
	ticks: number;
};

/**
 * Create initial inline code state.
 */
export function createInlineCodeState(): InlineCodeState {
	return { open: false, ticks: 0 };
}

type InlineCodeSpansResult = {
	spans: Array<[number, number]>;
	state: InlineCodeState;
};

/**
 * Index for checking if positions are inside code.
 */
export type CodeSpanIndex = {
	/** Updated inline code state after processing */
	inlineState: InlineCodeState;
	/** Check if an index is inside any code (fence or inline) */
	isInside: (index: number) => boolean;
};

/**
 * Build an index for checking if positions are inside code spans.
 *
 * This handles both fenced code blocks and inline code spans.
 * State can be passed in for streaming scenarios.
 *
 * @param text - The text to analyze
 * @param inlineState - Optional state from previous chunk
 * @returns Index object with isInside() method
 */
export function buildCodeSpanIndex(
	text: string,
	inlineState?: InlineCodeState,
): CodeSpanIndex {
	const fenceSpans = parseFenceSpans(text);
	const startState = inlineState
		? { open: inlineState.open, ticks: inlineState.ticks }
		: createInlineCodeState();
	const { spans: inlineSpans, state: nextInlineState } = parseInlineCodeSpans(
		text,
		fenceSpans,
		startState,
	);

	return {
		inlineState: nextInlineState,
		isInside: (index: number) =>
			isInsideFenceSpan(index, fenceSpans) ||
			isInsideInlineSpan(index, inlineSpans),
	};
}

function parseInlineCodeSpans(
	text: string,
	fenceSpans: FenceSpan[],
	initialState: InlineCodeState,
): InlineCodeSpansResult {
	const spans: Array<[number, number]> = [];
	let open = initialState.open;
	let ticks = initialState.ticks;
	let openStart = open ? 0 : -1;

	let i = 0;
	let fenceIndex = 0;
	while (i < text.length) {
		while (fenceIndex < fenceSpans.length && fenceSpans[fenceIndex].end <= i) {
			fenceIndex += 1;
		}
		const fence = fenceSpans[fenceIndex];
		if (fence && i >= fence.start) {
			i = fence.end;
			fenceIndex += 1;
			continue;
		}

		if (text[i] !== "`") {
			i += 1;
			continue;
		}

		const runStart = i;
		let runLength = 0;
		while (i < text.length && text[i] === "`") {
			runLength += 1;
			i += 1;
		}

		if (!open) {
			open = true;
			ticks = runLength;
			openStart = runStart;
			continue;
		}

		if (runLength === ticks) {
			spans.push([openStart, i]);
			open = false;
			ticks = 0;
			openStart = -1;
		}
	}

	if (open) {
		spans.push([openStart, text.length]);
	}

	return {
		spans,
		state: { open, ticks },
	};
}

function findOrderedRange<T>(
	spans: readonly T[],
	index: number,
	bounds: (span: T) => readonly [number, number],
): T | undefined {
	let lo = 0;
	let hi = spans.length - 1;
	while (lo <= hi) {
		const mid = lo + Math.floor((hi - lo) / 2);
		const span = spans[mid];
		const [start, end] = bounds(span);
		if (index < start) {
			hi = mid - 1;
		} else if (index >= end) {
			lo = mid + 1;
		} else {
			return span;
		}
	}
	return undefined;
}

function findFenceSpanAtInclusive(
	spans: FenceSpan[],
	index: number,
): FenceSpan | undefined {
	return findOrderedRange(spans, index, (span) => [span.start, span.end]);
}

function isInsideFenceSpan(index: number, spans: FenceSpan[]): boolean {
	return findFenceSpanAtInclusive(spans, index) !== undefined;
}

function isInsideInlineSpan(
	index: number,
	spans: Array<[number, number]>,
): boolean {
	return findOrderedRange(spans, index, (span) => span) !== undefined;
}
