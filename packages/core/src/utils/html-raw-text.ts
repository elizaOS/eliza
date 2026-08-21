/**
 * Removes HTML script and style elements with a bounded tokenizer pass.
 *
 * HTML end tags accept whitespace, a slash, or attributes after the tag name.
 * Regex-based filters routinely miss those parser-accepted forms and expose
 * raw script/style bodies as visible text after a later generic tag strip.
 */

const RAW_TEXT_TAGS = ["script", "style"] as const;

function isAsciiWhitespace(character: string): boolean {
	return (
		character === "\t" ||
		character === "\n" ||
		character === "\f" ||
		character === "\r" ||
		character === " "
	);
}

function matchesAsciiCaseInsensitive(
	value: string,
	index: number,
	expected: string,
): boolean {
	if (index + expected.length > value.length) return false;
	for (let offset = 0; offset < expected.length; offset += 1) {
		const code = value.charCodeAt(index + offset);
		const normalized = code >= 65 && code <= 90 ? code + 32 : code;
		if (normalized !== expected.charCodeAt(offset)) return false;
	}
	return true;
}

function isTagNameDelimiter(character: string | undefined): boolean {
	return (
		character === undefined ||
		character === ">" ||
		character === "/" ||
		isAsciiWhitespace(character)
	);
}

function findTagEnd(value: string, index: number): number {
	let quote: '"' | "'" | null = null;
	for (let cursor = index; cursor < value.length; cursor += 1) {
		const character = value[cursor];
		if (quote !== null) {
			if (character === quote) quote = null;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
		} else if (character === ">") {
			return cursor + 1;
		}
	}
	return value.length;
}

function matchTag(
	value: string,
	index: number,
	tagName: (typeof RAW_TEXT_TAGS)[number],
	closing: boolean,
): number | null {
	if (value[index] !== "<") return null;
	const nameIndex = index + (closing ? 2 : 1);
	if (closing && value[index + 1] !== "/") return null;
	if (!matchesAsciiCaseInsensitive(value, nameIndex, tagName)) return null;
	const afterName = nameIndex + tagName.length;
	if (!isTagNameDelimiter(value[afterName])) return null;
	return findTagEnd(value, afterName);
}

function hasDelimitedTagName(
	value: string,
	nameIndex: number,
	tagName: (typeof RAW_TEXT_TAGS)[number],
): boolean {
	return (
		matchesAsciiCaseInsensitive(value, nameIndex, tagName) &&
		isTagNameDelimiter(value[nameIndex + tagName.length])
	);
}

function findRawTextClosingEnd(
	value: string,
	index: number,
	tagName: (typeof RAW_TEXT_TAGS)[number],
): number | null {
	for (let cursor = index; cursor < value.length; cursor += 1) {
		if (value[cursor] !== "<" || value[cursor + 1] !== "/") continue;
		const closingEnd = matchTag(value, cursor, tagName, true);
		if (closingEnd !== null) return closingEnd;
	}
	return null;
}

type ScriptTextState = "data" | "escaped" | "double-escaped";

/**
 * Find the end of script data while preserving the browser tokenizer's escape
 * transitions. A script end-tag token seen while double-escaped only returns
 * the tokenizer to the escaped state; a later appropriate token closes it.
 */
function findScriptClosingEnd(value: string, index: number): number | null {
	let state: ScriptTextState = "data";
	let cursor = index;

	while (cursor < value.length) {
		if (value.startsWith("-->", cursor)) {
			state = "data";
			cursor += 3;
			continue;
		}

		if (state === "data" && value.startsWith("<!--", cursor)) {
			state = "escaped";
			cursor += 4;
			continue;
		}

		if (value[cursor] === "<" && value[cursor + 1] === "/") {
			const nameIndex = cursor + 2;
			if (hasDelimitedTagName(value, nameIndex, "script")) {
				if (state === "double-escaped") {
					state = "escaped";
					cursor = nameIndex + "script".length;
					continue;
				}
				return findTagEnd(value, nameIndex + "script".length);
			}
		}

		if (
			state === "escaped" &&
			value[cursor] === "<" &&
			hasDelimitedTagName(value, cursor + 1, "script")
		) {
			state = "double-escaped";
			cursor += 1 + "script".length;
			continue;
		}

		cursor += 1;
	}

	return null;
}

/** Remove script/style elements, including parser-accepted malformed end tags. */
export function stripHtmlRawTextElements(value: string): string {
	const output: string[] = [];
	let copiedThrough = 0;
	let cursor = 0;

	while (cursor < value.length) {
		if (value[cursor] !== "<") {
			cursor += 1;
			continue;
		}

		let matchedTag: (typeof RAW_TEXT_TAGS)[number] | null = null;
		let openingEnd = 0;
		for (const tagName of RAW_TEXT_TAGS) {
			const end = matchTag(value, cursor, tagName, false);
			if (end !== null) {
				matchedTag = tagName;
				openingEnd = end;
				break;
			}
		}
		if (matchedTag === null) {
			cursor += 1;
			continue;
		}

		output.push(value.slice(copiedThrough, cursor), " ");
		cursor = openingEnd;
		const closingEnd =
			matchedTag === "script"
				? findScriptClosingEnd(value, cursor)
				: findRawTextClosingEnd(value, cursor, matchedTag);
		if (closingEnd === null) {
			copiedThrough = value.length;
			cursor = value.length;
		} else {
			copiedThrough = closingEnd;
			cursor = closingEnd;
		}
	}

	output.push(value.slice(copiedThrough));
	return output.join("");
}
