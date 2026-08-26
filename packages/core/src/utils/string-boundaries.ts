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

export function trimStartCharacters(value: string, characters: string): string {
	const accepted = new Set(characters);
	let start = 0;
	while (start < value.length) {
		let end = start + 1;
		const first = value.charCodeAt(start);
		if (first >= 0xd800 && first <= 0xdbff && end < value.length) {
			const next = value.charCodeAt(end);
			if (next >= 0xdc00 && next <= 0xdfff) end += 1;
		}
		if (!accepted.has(value.slice(start, end))) break;
		start = end;
	}
	return start === 0 ? value : value.slice(start);
}

export function trimStartWhitespace(value: string): string {
	let start = 0;
	while (start < value.length && /\s/u.test(value[start])) start += 1;
	return start === 0 ? value : value.slice(start);
}
