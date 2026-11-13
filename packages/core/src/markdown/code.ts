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

type OpenFence = {
	start: number;
	markerChar: string;
	markerLen: number;
	openLine: string;
	marker: string;
	indent: string;
};

/**
 * Resumable line scan behind {@link parseFenceSpans}. `spans` holds the
 * fences closed so far; `open` is the fence still open at `offset`, the start
 * of the next unscanned line. Scanning a prefix yields exactly the spans a
 * full parse reports for that prefix, because fence state depends only on
 * earlier lines.
 */
export type FenceScan = {
	spans: FenceSpan[];
	open: OpenFence | undefined;
	offset: number;
	done: boolean;
};

export function startFenceScan(): FenceScan {
	return { spans: [], open: undefined, offset: 0, done: false };
}

/** Scan every line of `buffer` that starts at or before `lastLineStart`. */
export function advanceFenceScan(
	buffer: string,
	scan: FenceScan,
	lastLineStart: number,
): void {
	while (!scan.done && scan.offset <= lastLineStart) {
		const offset = scan.offset;
		const nextNewline = buffer.indexOf("\n", offset);
		const lineEnd = nextNewline === -1 ? buffer.length : nextNewline;
		const rawLine = buffer.slice(offset, lineEnd);
		// Treat the carriage return in CRLF input as a line ending, not fence info.
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

		const match = FENCE_LINE_RE.exec(line);
		const open = scan.open;
		if (match && (open || match[2][0] !== "`" || !match[3].includes("`"))) {
			const indent = match[1];
			const marker = match[2];
			const markerChar = marker[0];
			const markerLen = marker.length;
			if (!open) {
				scan.open = {
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
				scan.spans.push({
					start: open.start,
					end: lineEnd,
					openLine: open.openLine,
					marker: open.marker,
					indent: open.indent,
				});
				scan.open = undefined;
			}
		}

		if (nextNewline === -1) {
			scan.done = true;
			const unclosed = scan.open;
			if (unclosed) {
				scan.spans.push({
					start: unclosed.start,
					end: buffer.length,
					openLine: unclosed.openLine,
					marker: unclosed.marker,
					indent: unclosed.indent,
				});
				scan.open = undefined;
			}
			return;
		}
		scan.offset = nextNewline + 1;
	}
}

const FENCE_LINE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Parse all fenced code block spans from a string.
 *
 * Handles both backtick (```) and tilde (~~~) fences,
 * with proper matching of closing markers.
 *
 * @param buffer - The text to parse
 * @returns Array of fence spans found, ordered and non-overlapping
 */
export function parseFenceSpans(buffer: string): FenceSpan[] {
	const scan = startFenceScan();
	advanceFenceScan(buffer, scan, buffer.length);
	return scan.spans;
}

/**
 * Find the fence span strictly containing `index` (`start < index < end`).
 * `spans` must be ordered and non-overlapping, as {@link parseFenceSpans}
 * returns them.
 */
export function findFenceSpanAt(
	spans: readonly FenceSpan[],
	index: number,
): FenceSpan | undefined {
	const span = spans[lastSpanStartingBefore(spans, index)];
	return span && index < span.end ? span : undefined;
}

/**
 * Index of the last span whose start is before `index`, or -1. Ordered,
 * non-overlapping spans make that span the only candidate to contain `index`.
 */
function lastSpanStartingBefore(
	spans: readonly FenceSpan[],
	index: number,
): number {
	let lo = 0;
	let hi = spans.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		if (spans[mid].start < index) {
			found = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return found;
}

/**
 * Check if it's safe to break text at a given index (not inside a fence).
 *
 * @param spans - Array of fence spans
 * @param index - Position to check
 * @returns True if safe to break (not inside a fence)
 */
export function isSafeFenceBreak(
	spans: readonly FenceSpan[],
	index: number,
): boolean {
	return !findFenceSpanAt(spans, index);
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
	// Lowercase only the label region, not the whole (possibly large) value.
	let longestLanguage = 0;
	for (const language of languages) {
		longestLanguage = Math.max(longestLanguage, language.length);
	}
	const lowerLabel = value
		.slice(fenceLength, fenceLength + longestLanguage)
		.toLowerCase();
	const acceptedLanguage = [...languages]
		.sort((left, right) => right.length - left.length)
		.find((language) => lowerLabel.startsWith(language.toLowerCase()));
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
