/**
 * Finds first-sentence boundaries for direct and incremental text consumers.
 * The scanner preserves abbreviation, decimal, closer, and Unicode-whitespace
 * semantics while keeping reply/TTS streaming work linear in appended input.
 */

const ABBREVIATIONS = new Set([
	"mr",
	"mrs",
	"ms",
	"dr",
	"prof",
	"sr",
	"jr",
	"st",
	"vs",
	"etc",
	"e.g",
	"i.e",
]);

const SENTENCE_END = new Set([".", "?", "!"]);
const BOUNDARY_FOLLOWERS = new Set([
	'"',
	"'",
	"\u201D",
	"\u2019",
	")",
	"]",
	"}",
]);
const TRAILING_CLOSERS = "\"'\u201D\u2019)]}";

function isAsciiWordChar(ch: string): boolean {
	return (
		(ch >= "A" && ch <= "Z") ||
		(ch >= "a" && ch <= "z") ||
		(ch >= "0" && ch <= "9") ||
		ch === "_"
	);
}

function isBoundaryFollower(ch: string | undefined): boolean {
	return ch === undefined || /\s/.test(ch) || BOUNDARY_FOLLOWERS.has(ch);
}

export interface FirstSentenceScanner {
	/**
	 * Scan only the newly appended text. Returns the absolute boundary offset
	 * once a complete first sentence is found.
	 */
	push(chunk: string, endOfInput?: boolean): number | undefined;
}

export interface FirstSentenceStreamTracker {
	/** Scan one authoritative structured-field delta and its accumulation. */
	push(
		chunk: string,
		accumulated: string,
		streamRevision?: number,
	): number | undefined;
	/** Resolve punctuation still pending when the structured stream ends. */
	finish(): number | undefined;
}

/**
 * Incremental sentence-boundary scanner for append-only model streams.
 */
export function createFirstSentenceScanner(): FirstSentenceScanner {
	let lastWord = "";
	let scanned = 0;
	let completeAt: number | undefined;
	let pendingBoundary:
		| { boundary: number; normalizedWord: string; sawCloser: boolean }
		| undefined;

	return {
		push(chunk: string, endOfInput = false): number | undefined {
			if (completeAt !== undefined) return completeAt;
			if (pendingBoundary && (chunk.length > 0 || endOfInput)) {
				if (!ABBREVIATIONS.has(pendingBoundary.normalizedWord)) {
					let closerOffset = 0;
					while (
						closerOffset < chunk.length &&
						TRAILING_CLOSERS.includes(chunk[closerOffset])
					) {
						closerOffset += 1;
					}
					if (closerOffset > 0) {
						pendingBoundary.boundary += closerOffset;
						pendingBoundary.sawCloser = true;
						scanned += closerOffset;
					}
					if (closerOffset === chunk.length) {
						if (!endOfInput) return undefined;
						completeAt = pendingBoundary.boundary;
						return completeAt;
					}
					if (
						pendingBoundary.sawCloser ||
						isBoundaryFollower(chunk[closerOffset])
					) {
						completeAt = pendingBoundary.boundary;
						return completeAt;
					}
				}
				pendingBoundary = undefined;
			}

			for (let offset = 0; offset < chunk.length; offset += 1) {
				const char = chunk[offset];
				if (
					SENTENCE_END.has(char) &&
					chunk[offset + 1] === undefined &&
					!endOfInput
				) {
					const word = lastWord.endsWith(".")
						? lastWord.slice(0, -1)
						: lastWord;
					pendingBoundary = {
						boundary: scanned + offset + 1,
						normalizedWord: word.toLowerCase(),
						sawCloser: false,
					};
				} else if (
					SENTENCE_END.has(char) &&
					isBoundaryFollower(chunk[offset + 1])
				) {
					const word = lastWord.endsWith(".")
						? lastWord.slice(0, -1)
						: lastWord;
					if (!ABBREVIATIONS.has(word.toLowerCase())) {
						let boundary = offset + 1;
						while (
							boundary < chunk.length &&
							TRAILING_CLOSERS.includes(chunk[boundary])
						) {
							boundary += 1;
						}
						if (boundary === chunk.length && !endOfInput) {
							pendingBoundary = {
								boundary: scanned + boundary,
								normalizedWord: word.toLowerCase(),
								sawCloser: boundary > offset + 1,
							};
							break;
						}
						completeAt = scanned + boundary;
						return completeAt;
					}
				}
				if (isAsciiWordChar(char) || char === ".") {
					lastWord += char;
				} else {
					lastWord = "";
				}
			}

			scanned += chunk.length;
			return undefined;
		},
	};
}

/**
 * Reconciles authoritative structured-stream accumulation with incremental
 * scanning. A retry starts a shorter or otherwise non-appended accumulation;
 * replay that new attempt instead of combining it with stale scanner state.
 */
export function createFirstSentenceStreamTracker(): FirstSentenceStreamTracker {
	let scanner = createFirstSentenceScanner();
	let accumulatedLength = 0;
	let activeRevision: number | undefined;

	return {
		push(
			chunk: string,
			accumulated: string,
			streamRevision?: number,
		): number | undefined {
			if (
				streamRevision !== undefined &&
				activeRevision !== undefined &&
				streamRevision < activeRevision
			) {
				return undefined;
			}
			const revisionChanged =
				streamRevision !== undefined && streamRevision !== activeRevision;
			const appended =
				accumulated.length === accumulatedLength + chunk.length &&
				accumulated.slice(accumulatedLength) === chunk;
			if (revisionChanged || !appended) {
				scanner = createFirstSentenceScanner();
				accumulatedLength = accumulated.length;
				activeRevision = streamRevision;
				return scanner.push(accumulated);
			}
			accumulatedLength = accumulated.length;
			activeRevision = streamRevision;
			return scanner.push(chunk);
		},
		finish(): number | undefined {
			return scanner.push("", true);
		},
	};
}

export function extractFirstSentence(text: string): {
	first: string;
	rest: string;
	/** Whether a sentence boundary was actually found in `text`. */
	complete: boolean;
} {
	const boundaryIndex = createFirstSentenceScanner().push(text, true);

	if (boundaryIndex !== undefined) {
		const first = text.substring(0, boundaryIndex).trim();
		const rest = text.substring(boundaryIndex).trim();
		return { first, rest, complete: true };
	}

	return { first: text.trim(), rest: "", complete: false };
}

/**
 * Checks if the text likely contains a complete first sentence.
 * Useful for streaming to know when to call extractFirstSentence.
 */
export function hasFirstSentence(text: string): boolean {
	// A boundary at the end of the text still completes a sentence, so this
	// cannot key off `rest`: a reply that is exactly one sentence leaves it
	// empty and would report false.
	return extractFirstSentence(text).complete;
}
