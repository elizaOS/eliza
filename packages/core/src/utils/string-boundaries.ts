/** Provides linear boundary trimming for explicit character sets and whitespace. */

export function trimEndCharacters(value: string, characters: string): string {
	const accepted = new Set(characters);
	let end = value.length;
	while (end > 0) {
		let start = end - 1;
		const last = value.charCodeAt(start);
		if (last >= 0xdc00 && last <= 0xdfff && start > 0) {
			const previous = value.charCodeAt(start - 1);
			if (previous >= 0xd800 && previous <= 0xdbff) start -= 1;
		}
		if (!accepted.has(value.slice(start, end))) break;
		end = start;
	}
	return end === value.length ? value : value.slice(0, end);
}

export function trimEndWhitespace(value: string): string {
	let end = value.length;
	while (end > 0 && /\s/u.test(value[end - 1])) end -= 1;
	return end === value.length ? value : value.slice(0, end);
}
