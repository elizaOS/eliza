/** Provides linear boundary trimming for explicit character sets and whitespace. */
import { toWellFormedUnicode } from "./well-formed.js";

export function trimEndCharacters(value: string, characters: string): string {
	const wellFormed = toWellFormedUnicode(value);
	const accepted = new Set(characters);
	let end = wellFormed.length;
	while (end > 0) {
		let start = end - 1;
		const last = wellFormed.charCodeAt(start);
		if (last >= 0xdc00 && last <= 0xdfff && start > 0) {
			const previous = wellFormed.charCodeAt(start - 1);
			if (previous >= 0xd800 && previous <= 0xdbff) start -= 1;
		}
		if (!accepted.has(wellFormed.slice(start, end))) break;
		end = start;
	}
	return end === wellFormed.length ? wellFormed : wellFormed.slice(0, end);
}

export function trimEndWhitespace(value: string): string {
	const wellFormed = toWellFormedUnicode(value);
	let end = wellFormed.length;
	while (end > 0 && /\s/u.test(wellFormed[end - 1])) end -= 1;
	if (end > 0) {
		const code = wellFormed.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) {
			end -= 1;
		}
	}
	return end === wellFormed.length ? wellFormed : wellFormed.slice(0, end);
}
