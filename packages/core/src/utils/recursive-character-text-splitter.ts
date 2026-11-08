/**
 * Character-count text chunker: recursively splits text on separators from
 * coarsest to finest (paragraph, line, space, grapheme cluster) and re-merges
 * adjacent pieces up to chunkSize, carrying chunkOverlap between successive
 * chunks. The finest grain is a grapheme cluster, not a UTF-16 unit, so an
 * astral character cannot be emitted as a lone surrogate and a ZWJ emoji
 * sequence, a flag, a combining mark, or a skin-tone modifier cannot be cut
 * across chunks. Incoming text is passed through {@link toWellFormedUnicode}
 * so pre-existing lone surrogates become U+FFFD before chunking; every emitted
 * chunk is well-formed. The length function may be async; chunkOverlap must be
 * < chunkSize or the constructor throws. Pieces that still exceed chunkSize are
 * emitted and logged as a warning.
 */

import logger from "../logger";
import { toWellFormedUnicode } from "./unicode";

// The pinned runtimes provide Intl.Segmenter, while the declaration library
// does not expose its type.
const GraphemeSegmenter = (
	Intl as unknown as {
		Segmenter: new (
			locale: string,
			options: { granularity: "grapheme" },
		) => { segment(text: string): Iterable<{ segment: string }> };
	}
).Segmenter;

const graphemeSegmenter = new GraphemeSegmenter("en", {
	granularity: "grapheme",
});

/** Parameters for {@link RecursiveCharacterTextSplitter}. */
export interface RecursiveCharacterTextSplitterParams {
	chunkSize?: number;
	chunkOverlap?: number;
	separators?: string[];
	keepSeparator?: boolean;
	lengthFunction?: (text: string) => number | Promise<number>;
}

/**
 * Recursively splits text on progressively finer separators until chunks fit `chunkSize`,
 * merging small pieces with overlap handling (character-length; default keepSeparator: true).
 */
export class RecursiveCharacterTextSplitter {
	private chunkSize: number;
	private chunkOverlap: number;
	private separators: string[];
	private keepSeparator: boolean;
	private lengthFunction: (text: string) => number | Promise<number>;

	constructor(fields?: RecursiveCharacterTextSplitterParams) {
		const chunkSize = fields?.chunkSize ?? 1000;
		const chunkOverlap = fields?.chunkOverlap ?? 200;
		if (chunkOverlap >= chunkSize) {
			throw new Error("Cannot have chunkOverlap >= chunkSize");
		}
		this.chunkSize = chunkSize;
		this.chunkOverlap = chunkOverlap;
		this.separators = fields?.separators ?? ["\n\n", "\n", " ", ""];
		this.keepSeparator = fields?.keepSeparator ?? true;
		this.lengthFunction = fields?.lengthFunction ?? ((t: string) => t.length);
	}

	private splitOnSeparator(text: string, separator: string): string[] {
		let splits: string[];
		if (separator) {
			if (this.keepSeparator) {
				const regexEscapedSeparator = separator.replace(
					/[/\-\\^$*+?.()|[\]{}]/g,
					"\\$&",
				);
				splits = text.split(new RegExp(`(?=${regexEscapedSeparator})`));
			} else {
				splits = text.split(separator);
			}
		} else {
			// Finest grain is a grapheme cluster. Splitting by code point
			// (Array.from) cuts ZWJ emoji sequences, flags, combining marks,
			// and skin-tone modifiers across chunks, so the two halves render
			// as different characters in each chunk.
			splits = Array.from(
				graphemeSegmenter.segment(text),
				({ segment }) => segment,
			);
		}
		return splits.filter((s) => s !== "");
	}

	private joinDocs(docs: string[], separator: string): string | null {
		const joined = docs.join(separator).trim();
		return joined === "" ? null : joined;
	}

	private async mergeSplits(
		splits: string[],
		separator: string,
	): Promise<string[]> {
		const docs: string[] = [];
		const currentDoc: string[] = [];
		const separatorLength = await this.lengthFunction(separator);
		let total = 0;
		for (const d of splits) {
			const len = await this.lengthFunction(d);
			if (
				total + len + (currentDoc.length > 0 ? separatorLength : 0) >
				this.chunkSize
			) {
				if (total > this.chunkSize) {
					logger.warn(
						`[RecursiveCharacterTextSplitter] Created a chunk of size ${total}, which is longer than the specified ${this.chunkSize}`,
					);
				}
				if (currentDoc.length > 0) {
					const doc = this.joinDocs(currentDoc, separator);
					if (doc !== null) docs.push(doc);
					while (
						total > this.chunkOverlap ||
						(total + len + (currentDoc.length > 0 ? separatorLength : 0) >
							this.chunkSize &&
							total > 0)
					) {
						const first = currentDoc[0];
						if (first === undefined) break;
						total -=
							(await this.lengthFunction(first)) +
							(currentDoc.length > 1 ? separatorLength : 0);
						currentDoc.shift();
					}
				}
			}
			currentDoc.push(d);
			total += len + (currentDoc.length > 1 ? separatorLength : 0);
		}
		const doc = this.joinDocs(currentDoc, separator);
		if (doc !== null) docs.push(doc);
		return docs;
	}

	private async _splitText(
		text: string,
		separators: string[],
	): Promise<string[]> {
		const finalChunks: string[] = [];
		let separator = separators[separators.length - 1] ?? "";
		let newSeparators: string[] | undefined;
		for (let i = 0; i < separators.length; i += 1) {
			const s = separators[i];
			if (s === undefined) continue;
			if (s === "") {
				separator = s;
				break;
			}
			if (text.includes(s)) {
				separator = s;
				newSeparators = separators.slice(i + 1);
				break;
			}
		}
		const splits = this.splitOnSeparator(text, separator);
		const goodSplits: string[] = [];
		const sepForMerge = this.keepSeparator ? "" : separator;
		for (const s of splits) {
			const splitLength = await this.lengthFunction(s);
			if (splitLength <= this.chunkSize) {
				goodSplits.push(s);
			} else {
				if (goodSplits.length) {
					const mergedText = await this.mergeSplits(goodSplits, sepForMerge);
					finalChunks.push(...mergedText);
					goodSplits.length = 0;
				}
				if (!newSeparators) {
					if (splitLength > this.chunkSize) {
						logger.warn(
							`[RecursiveCharacterTextSplitter] Created a chunk of size ${splitLength}, which is longer than the specified ${this.chunkSize}`,
						);
					}
					finalChunks.push(s);
				} else {
					const otherInfo = await this._splitText(s, newSeparators);
					finalChunks.push(...otherInfo);
				}
			}
		}
		if (goodSplits.length) {
			const mergedText = await this.mergeSplits(goodSplits, sepForMerge);
			finalChunks.push(...mergedText);
		}
		return finalChunks;
	}

	async splitText(text: string): Promise<string[]> {
		return this._splitText(toWellFormedUnicode(text), this.separators);
	}
}
