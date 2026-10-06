/** Parses Markdown code fences and identifies positions where text can be split safely. */

/**
 * Represents a fenced code block span in the text.
 */
export type FenceSpan = {
	/** Start offset of the fence in the text */
	start: number;
	/** End offset of the fence in the text */
	end: number;
	/** The opening line of the fence (e.g., "```typescript") */
	openLine: string;
	/** The marker characters (e.g., "```" or "~~~") */
	marker: string;
	/** Leading whitespace/indent before the marker */
	indent: string;
};

/**
 * Parse all fenced code block spans from a string.
 *
 * Handles both backtick (```) and tilde (~~~) fences,
 * with proper matching of closing markers.
 *
 * @param buffer - The text to parse
 * @returns Array of fence spans found
 */
export function parseFenceSpans(buffer: string): FenceSpan[] {
	const spans: FenceSpan[] = [];
	let open:
		| {
				start: number;
				markerChar: string;
				markerLen: number;
				openLine: string;
				marker: string;
				indent: string;
		  }
		| undefined;

	let offset = 0;
	while (offset <= buffer.length) {
		const nextNewline = buffer.indexOf("\n", offset);
		const lineEnd = nextNewline === -1 ? buffer.length : nextNewline;
		const rawLine = buffer.slice(offset, lineEnd);
		// Treat the carriage return in CRLF input as a line ending, not fence info.
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

		const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
		if (match) {
			const indent = match[1];
			const marker = match[2];
			const markerChar = marker[0];
			const markerLen = marker.length;
			if (!open) {
				open = {
					start: offset,
					markerChar,
					markerLen,
					openLine: line,
					marker,
					indent,
				};
			} else if (
				open.markerChar === markerChar &&
				markerLen >= open.markerLen &&
				// A closing fence may be followed only by spaces/tabs (CommonMark);
				// a line like "```js" inside an open fence is content, not a closer.
				/^[ \t]*$/.test(match[3])
			) {
				const end = lineEnd;
				spans.push({
					start: open.start,
					end,
					openLine: open.openLine,
					marker: open.marker,
					indent: open.indent,
				});
				open = undefined;
			}
		}

		if (nextNewline === -1) {
			break;
		}
		offset = nextNewline + 1;
	}

	if (open) {
		spans.push({
			start: open.start,
			end: buffer.length,
			openLine: open.openLine,
			marker: open.marker,
			indent: open.indent,
		});
	}

	return spans;
}

/**
 * Find the fence span that contains a given index.
 *
 * @param spans - Array of fence spans to search
 * @param index - Position to check
 * @returns The fence span containing the index, or undefined
 */
export function findFenceSpanAt(
	spans: FenceSpan[],
	index: number,
): FenceSpan | undefined {
	return spans.find((span) => index > span.start && index < span.end);
}

/**
 * Check if it's safe to break text at a given index (not inside a fence).
 *
 * @param spans - Array of fence spans
 * @param index - Position to check
 * @returns True if safe to break (not inside a fence)
 */
export function isSafeFenceBreak(spans: FenceSpan[], index: number): boolean {
	return !findFenceSpanAt(spans, index);
}

/**
 * Detects backtick-delimited inline code while preserving state across streamed
 * chunks. Parsing sweeps ordered fence spans once, while arbitrary membership
 * queries use binary search, so hostile fence-heavy input remains bounded.
 */

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

/** Removes an optional whole-value Markdown code fence with a linear delimiter scan. */

export function unwrapWholeCodeFence(
	value: string,
	languages: readonly string[],
): string | null {
	let fenceLength = 0;
	while (value[fenceLength] === "`") fenceLength += 1;
	if (fenceLength < 3 || value.length < fenceLength * 2) {
		return null;
	}
	const lowerValue = value.toLowerCase();
	const acceptedLanguage = [...languages]
		.sort((left, right) => right.length - left.length)
		.find((language) =>
			lowerValue.startsWith(language.toLowerCase(), fenceLength),
		);
	let cursor = acceptedLanguage
		? fenceLength + acceptedLanguage.length
		: fenceLength;
	if (!acceptedLanguage) {
		while (
			cursor < value.length - fenceLength &&
			/[A-Za-z0-9]/.test(value[cursor])
		)
			cursor += 1;
		const language = value.slice(fenceLength, cursor);
		// A whitespace-delimited token is an explicit (unsupported) language
		// label. Otherwise it is compact unlabeled content such as ```true``` or
		// ```name: value```, which the previous whole-fence parsers accepted.
		if (language && /\s/u.test(value[cursor] ?? "")) return null;
		cursor = fenceLength;
	}
	while (cursor < value.length - fenceLength && /\s/u.test(value[cursor]))
		cursor += 1;
	let end = value.length;
	while (end > cursor && value[end - 1] === "`") end -= 1;
	if (value.length - end < fenceLength) return null;
	while (end > cursor && /\s/u.test(value[end - 1])) end -= 1;
	return value.slice(cursor, end);
}
