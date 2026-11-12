/**
 * Finds first-sentence boundaries for direct and incremental text consumers.
 * The scanner preserves abbreviation, decimal, closer, and Unicode-whitespace
 * semantics while keeping reply/TTS streaming work linear in appended input.
 */

const TIME_ABBREVIATIONS = new Set(["a.m", "p.m"]);
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
	// Initialisms: "U.S." must not end a sentence.
	"u.s",
	"u.k",
	"u.s.a",
	"d.c",
	"ph.d",
	"b.a",
	"m.d",
	...TIME_ABBREVIATIONS,
]);

// Abbreviations that take a number ("No. 5", "Vol. 3"). These are NOT in
// ABBREVIATIONS on purpose: a sentence can genuinely end with one
// ("No. I disagree completely."), so only a following digit suppresses
// the boundary (see nextMeaningfulChar below).
const NUMBER_TAKING_ABBREVIATIONS = new Set([
	// Month abbreviations, digit-gated like No./Vol.: "Jan. 2024" must not
	// end a sentence, but "It happened in Dec. It was cold." must.
	"jan",
	"feb",
	"mar",
	"apr",
	"jun",
	"jul",
	"aug",
	"sep",
	"sept",
	"oct",
	"nov",
	"dec",
	"no",
	"vol",
	"fig",
	"pp",
	"sec",
	"ch",
	"eq",
]);

const UNSPACED_SENTENCE_END = new Set(["。", "？", "！"]);
const SENTENCE_END = new Set([".", "?", "!", ...UNSPACED_SENTENCE_END]);
const BOUNDARY_FOLLOWERS = new Set([
	'"',
	"'",
	"\u201D",
	"\u2019",
	")",
	"]",
	"}",
	"」",
	"』",
	"）",
	"］",
	"｝",
	"】",
]);
const TRAILING_CLOSERS = "\"'\u201D\u2019)]}」』）］｝】";

function isDigit(ch: string | undefined): boolean {
	return ch !== undefined && ch >= "0" && ch <= "9";
}

/**
 * First character that carries meaning at or after `from`, skipping
 * spaces, tabs, and sentence closers. Used to decide whether a
 * number-taking abbreviation continues into a number ("No. 5") instead
 * of ending the sentence. Stops at a line break: a paragraph break is a
 * hard boundary, so a digit on a later line ("no.\n5 people") does not
 * continue the abbreviation the way "No. 5" on one line does.
 */
function nextMeaningfulChar(text: string, from: number): string | undefined {
	for (let i = from; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === " " || ch === "\t" || TRAILING_CLOSERS.includes(ch)) continue;
		if (ch === "\n" || ch === "\r") return undefined;
		return ch;
	}
	return undefined;
}

/**
 * Dotted country abbreviations. Unlike titles ("Dr.", "Mr."), these
 * commonly end a sentence ("She lives in D.C."), so a period after one
 * is a boundary when the sentence does not continue.
 */
const COUNTRY_ABBREVIATIONS = new Set(["u.s", "u.k", "u.s.a", "d.c"]);

/**
 * Degree initialisms ("Ph.D.", "B.A.", "M.D."). They end a sentence the
 * same way country abbreviations do ("She has a Ph.D. She teaches.").
 */
const DEGREE_ABBREVIATIONS = new Set(["ph.d", "b.a", "m.d"]);

/** Dotted initialisms that can end a sentence (country + degree). */
const SENTENCE_ENDING_INITIALISMS = new Set([
	...COUNTRY_ABBREVIATIONS,
	...DEGREE_ABBREVIATIONS,
]);

/**
 * Words that open a new sentence. A dotted initialism modifies a noun
 * ("U.S. Army", "Ph.D. candidate"), so a following pronoun,
 * demonstrative, or title means the initialism ended the sentence
 * instead: a title ("Dr.", "Mr.") cannot be modified by an initialism.
 * (Country part mirrors open #38252.)
 */
const SENTENCE_START_WORDS = new Set([
	"i",
	"it",
	"he",
	"she",
	"they",
	"we",
	"you",
	"this",
	"that",
	"these",
	"those",
	"there",
	"here",
	"my",
	"his",
	"her",
	"their",
	"our",
	"your",
	"its",
	// Titles open a new sentence after an initialism.
	"dr",
	"mr",
	"mrs",
	"ms",
	"prof",
]);

/**
 * Looks past the whitespace and closers after a candidate boundary.
 * `nextWord` is the word that follows, when one is present in `text`.
 * `boundaryEnd` is the offset just after the last closer, so a boundary
 * here still includes trailing closers. `gapEnd` is the offset where the
 * gap ends: when it is short of `text.length`, a non-word character
 * follows instead of a word. `wordEnd` is the offset just past
 * `nextWord` (`gapEnd` when there is no word): when it equals
 * `text.length`, the word may still continue in a later chunk.
 */
function peekAfterBoundary(
	text: string,
	start: number,
): {
	nextWord: string | undefined;
	boundaryEnd: number;
	gapEnd: number;
	wordEnd: number;
} {
	let index = start;
	let boundaryEnd = start;
	while (
		index < text.length &&
		(/\s/.test(text[index]) || TRAILING_CLOSERS.includes(text[index]))
	) {
		if (TRAILING_CLOSERS.includes(text[index])) {
			boundaryEnd = index + 1;
		}
		index += 1;
	}
	let nextWord: string | undefined;
	let wordEnd = index;
	if (index < text.length && isAsciiWordChar(text[index])) {
		let end = index;
		while (end < text.length && isAsciiWordChar(text[end])) {
			end += 1;
		}
		nextWord = text.slice(index, end);
		wordEnd = end;
	}
	return { nextWord, boundaryEnd, gapEnd: index, wordEnd };
}

/**
 * Decides whether a period after a dotted initialism ends the sentence.
 * A following sentence-start word ends it; any other word continues it.
 * A word cut off at the end of the text may still grow in a later chunk,
 * so it waits instead of deciding. With no word left, only end of input
 * ends it. A non-word character after the gap is left for the scanner to
 * handle.
 */
function decideInitialismBoundary(
	peeked: { nextWord: string | undefined; gapEnd: number; wordEnd: number },
	textLength: number,
	endOfInput: boolean,
): "boundary" | "continue" | "wait" {
	if (peeked.nextWord !== undefined) {
		if (peeked.wordEnd === textLength && !endOfInput) {
			return "wait";
		}
		return SENTENCE_START_WORDS.has(peeked.nextWord.toLowerCase())
			? "boundary"
			: "continue";
	}
	if (peeked.gapEnd === textLength) {
		return endOfInput ? "boundary" : "wait";
	}
	return "continue";
}

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
	// A time can end a reply, but only EOF proves it does not continue.
	let terminalTimeBoundary: number | undefined;
	let pendingBoundary:
		| {
				boundary: number;
				normalizedWord: string;
				sawCloser: boolean;
				unspaced: boolean;
				// Set when a number-taking abbreviation ("No.") is followed
				// only by whitespace/closers at the end of a chunk: the next
				// chunk decides digit (suppress) or not (complete at the
				// stored boundary).
				numberDeferred?: boolean;
				// Set with numberDeferred when a line break already
				// intervened ("No.\n" at the end of a chunk): a digit in
				// the next chunk must not suppress the boundary, because
				// nextMeaningfulChar only sees the new chunk.
				lineBreakDeferred?: boolean;
				// Set when the word after a dotted initialism was cut off
				// at the end of a chunk ("U.S. Sh" + "e ..."): the stored
				// prefix plus the next chunk's leading word chars is the
				// word the boundary decision must read.
				partialWord?: string;
		  }
		| undefined;

	return {
		push(chunk: string, endOfInput = false): number | undefined {
			if (completeAt !== undefined) return completeAt;
			if (pendingBoundary && (chunk.length > 0 || endOfInput)) {
				if (
					SENTENCE_ENDING_INITIALISMS.has(pendingBoundary.normalizedWord)
				) {
					const peeked = peekAfterBoundary(chunk, 0);
					// The word after the initialism may be split across
					// chunks: a stored prefix plus this chunk's leading
					// word chars is the word to decide on. When this chunk
					// does not continue the word, the stored prefix is the
					// whole word (a separator ended it at the chunk edge).
					let effectiveWord = peeked.nextWord;
					let effectiveWordEnd = peeked.wordEnd;
					if (pendingBoundary.partialWord !== undefined) {
						if (chunk.length > 0 && isAsciiWordChar(chunk[0])) {
							let end = 0;
							while (end < chunk.length && isAsciiWordChar(chunk[end])) {
								end += 1;
							}
							effectiveWord = pendingBoundary.partialWord + chunk.slice(0, end);
							effectiveWordEnd = end;
						} else {
							effectiveWord = pendingBoundary.partialWord;
							effectiveWordEnd = 0;
						}
					}
					const decision = decideInitialismBoundary(
						{
							nextWord: effectiveWord,
							gapEnd: effectiveWordEnd,
							wordEnd: effectiveWordEnd,
						},
						chunk.length,
						endOfInput,
					);
					if (decision === "boundary") {
						completeAt =
							peeked.boundaryEnd > 0
								? scanned + peeked.boundaryEnd
								: pendingBoundary.boundary;
						return completeAt;
					}
					if (decision === "wait") {
						if (effectiveWord !== undefined) {
							pendingBoundary.partialWord = effectiveWord;
							// The chunk's leading word chars are consumed
							// here, so the next chunk must continue the
							// word from here, not from the stale prefix.
							lastWord = effectiveWord;
						}
						if (peeked.boundaryEnd > 0) {
							pendingBoundary.boundary = scanned + peeked.boundaryEnd;
						}
						scanned += chunk.length;
						return undefined;
					}
					// "continue": the initialism does not end the sentence.
					// Drop the pending boundary and scan the chunk normally.
					pendingBoundary = undefined;
				} else if (pendingBoundary.numberDeferred) {
					// A chunk of only whitespace/closers decides nothing yet:
					// a digit may still arrive ("No. " + " " + "5 ...").
					// Wait for the next chunk instead of completing early.
					const peeked = peekAfterBoundary(chunk, 0);
					if (
						!endOfInput &&
						peeked.nextWord === undefined &&
						peeked.gapEnd === chunk.length
					) {
						if (/[\r\n]/.test(chunk)) {
							pendingBoundary.lineBreakDeferred = true;
						}
						if (peeked.boundaryEnd > 0) {
							pendingBoundary.boundary = scanned + peeked.boundaryEnd;
						}
						scanned += chunk.length;
						return undefined;
					}
					// The period was already followed by space/closers in the
					// previous chunk, so the stored boundary is final: a
					// following digit suppresses it, anything else confirms it.
					// Unless a line break already intervened: then the
					// boundary stands even before a digit ("No.\n" + "5").
					if (
						!pendingBoundary.lineBreakDeferred &&
						NUMBER_TAKING_ABBREVIATIONS.has(pendingBoundary.normalizedWord) &&
						isDigit(nextMeaningfulChar(chunk, 0))
					) {
						pendingBoundary = undefined;
					} else {
						completeAt = pendingBoundary.boundary;
						return completeAt;
					}
				} else {
					// A number-taking abbreviation followed only by
					// whitespace/closers in this chunk may still continue
					// into a digit ("No." + " " + "5 ..."): defer the
					// decision instead of completing at the stored boundary.
					const peeked = peekAfterBoundary(chunk, 0);
					if (
						NUMBER_TAKING_ABBREVIATIONS.has(
							pendingBoundary.normalizedWord,
						) &&
						!endOfInput &&
						peeked.nextWord === undefined &&
						peeked.gapEnd === chunk.length
					) {
						pendingBoundary.numberDeferred = true;
						pendingBoundary.lineBreakDeferred = /[\r\n]/.test(chunk);
						if (peeked.boundaryEnd > 0) {
							pendingBoundary.boundary = scanned + peeked.boundaryEnd;
						}
						scanned += chunk.length;
						return undefined;
					}
					const numberContinues =
						NUMBER_TAKING_ABBREVIATIONS.has(pendingBoundary.normalizedWord) &&
						isDigit(nextMeaningfulChar(chunk, 0));
					if (
						!numberContinues &&
						!ABBREVIATIONS.has(pendingBoundary.normalizedWord)
					) {
						let closerOffset = 0;
						if (pendingBoundary.unspaced && !pendingBoundary.sawCloser) {
							while (
								closerOffset < chunk.length &&
								SENTENCE_END.has(chunk[closerOffset])
							) {
								closerOffset += 1;
							}
							pendingBoundary.boundary += closerOffset;
							scanned += closerOffset;
						}
						const terminatorOffset = closerOffset;
						while (
							closerOffset < chunk.length &&
							TRAILING_CLOSERS.includes(chunk[closerOffset])
						) {
							closerOffset += 1;
						}
						if (closerOffset > terminatorOffset) {
							pendingBoundary.boundary += closerOffset - terminatorOffset;
							pendingBoundary.sawCloser = true;
							scanned += closerOffset - terminatorOffset;
						}
						if (closerOffset === chunk.length) {
							if (!endOfInput) return undefined;
							completeAt = pendingBoundary.boundary;
							return completeAt;
						}
						if (
							pendingBoundary.unspaced ||
							pendingBoundary.sawCloser ||
							isBoundaryFollower(chunk[closerOffset])
						) {
							completeAt = pendingBoundary.boundary;
							return completeAt;
						}
					}
					pendingBoundary = undefined;
				}
			}

			for (let offset = 0; offset < chunk.length; offset += 1) {
				const char = chunk[offset];
				if (terminalTimeBoundary !== undefined) {
					if (TRAILING_CLOSERS.includes(char)) {
						terminalTimeBoundary = scanned + offset + 1;
					} else if (!/\s/.test(char)) {
						terminalTimeBoundary = undefined;
					}
				}
				if (
					char === "." &&
					TIME_ABBREVIATIONS.has(lastWord.toLowerCase()) &&
					isBoundaryFollower(chunk[offset + 1])
				) {
					terminalTimeBoundary = scanned + offset + 1;
				}
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
						// Only a period can belong to an abbreviation ("a.m.?" ends
						// the sentence at "?").
						normalizedWord: char === "." ? word.toLowerCase() : "",
						sawCloser: false,
						unspaced: UNSPACED_SENTENCE_END.has(char),
					};
				} else if (
					SENTENCE_END.has(char) &&
					(UNSPACED_SENTENCE_END.has(char) ||
						isBoundaryFollower(chunk[offset + 1]))
				) {
					const word = lastWord.endsWith(".")
						? lastWord.slice(0, -1)
						: lastWord;
					const normalizedWord = word.toLowerCase();
					const isInitialism =
						char === "." &&
						SENTENCE_ENDING_INITIALISMS.has(normalizedWord);
					if (isInitialism) {
						// Dotted initialisms ("U.S.", "Ph.D.") end a sentence
						// when the next word starts one, or at end of input.
						// The country part mirrors open #38252.
						let boundary = offset + 1;
						while (
							boundary < chunk.length &&
							TRAILING_CLOSERS.includes(chunk[boundary])
						) {
							boundary += 1;
						}
						const peeked = peekAfterBoundary(chunk, boundary);
						const decision = decideInitialismBoundary(
							peeked,
							chunk.length,
							endOfInput,
						);
						if (decision === "boundary") {
							completeAt = scanned + peeked.boundaryEnd;
							return completeAt;
						}
						if (decision === "wait") {
							pendingBoundary = {
								boundary: scanned + peeked.boundaryEnd,
								normalizedWord,
								sawCloser: peeked.boundaryEnd > offset + 1,
								unspaced: false,
								// The following word was cut off at the end
								// of this chunk: keep its prefix so the next
								// chunk decides on the whole word.
								partialWord: peeked.nextWord,
							};
							// Do not break: the rest of this chunk is only
							// the gap and the cut-off word, so keep scanning
							// it — lastWord then carries the word's prefix
							// into the next chunk.
						}
						// "continue": the initialism does not end the
						// sentence. Keep scanning; the generic path below
						// must not run for this period.
					}
					const numberContinues =
						char === "." &&
						NUMBER_TAKING_ABBREVIATIONS.has(normalizedWord) &&
						isDigit(nextMeaningfulChar(chunk, offset + 1));
					if (
						!isInitialism &&
						!numberContinues &&
						(char !== "." || !ABBREVIATIONS.has(normalizedWord))
					) {
						let boundary = offset + 1;
						if (UNSPACED_SENTENCE_END.has(char)) {
							while (
								boundary < chunk.length &&
								SENTENCE_END.has(chunk[boundary])
							) {
								boundary += 1;
							}
						}
						const terminatorBoundary = boundary;
						while (
							boundary < chunk.length &&
							TRAILING_CLOSERS.includes(chunk[boundary])
						) {
							boundary += 1;
						}
						if (boundary === chunk.length && !endOfInput) {
							pendingBoundary = {
								boundary: scanned + boundary,
								normalizedWord: char === "." ? word.toLowerCase() : "",
								sawCloser: boundary > terminatorBoundary,
								unspaced: UNSPACED_SENTENCE_END.has(char),
							};
							break;
						}
						if (
							!endOfInput &&
							char === "." &&
							NUMBER_TAKING_ABBREVIATIONS.has(normalizedWord) &&
							nextMeaningfulChar(chunk, boundary) === undefined
						) {
							// The period is followed only by whitespace/closers
							// so far: defer the decision to the next chunk,
							// which may still bring a digit ("No. " + "5 ...").
							// A line break in the skipped span already ends
							// the sentence, so record it: the next chunk's
							// digit must not revive the abbreviation.
							pendingBoundary = {
								boundary: scanned + boundary,
								normalizedWord,
								sawCloser: boundary > terminatorBoundary,
								unspaced: false,
								numberDeferred: true,
								lineBreakDeferred: /[\r\n]/.test(chunk.slice(boundary)),
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
			if (endOfInput) completeAt = terminalTimeBoundary;
			return completeAt;
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
