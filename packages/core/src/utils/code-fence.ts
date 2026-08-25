/** Removes an optional whole-value Markdown code fence with a linear delimiter scan. */

export function unwrapWholeCodeFence(
	value: string,
	languages: readonly string[],
): string | null {
	if (!value.startsWith("```") || !value.endsWith("```") || value.length < 6) {
		return null;
	}
	const lowerValue = value.toLowerCase();
	const sorted = [...languages].sort(
		(left, right) => right.length - left.length,
	);
	let acceptedLanguage: string | undefined;
	for (const language of sorted) {
		const lowerLang = language.toLowerCase();
		if (!lowerValue.startsWith(lowerLang, 3)) continue;
		const afterIdx = 3 + language.length;
		let extEnd = afterIdx;
		while (extEnd < value.length && /[A-Za-z0-9]/.test(value[extEnd])) {
			extEnd += 1;
		}
		if (extEnd > afterIdx && /\s/u.test(value[extEnd] ?? "")) continue;
		acceptedLanguage = language;
		break;
	}
	let cursor = acceptedLanguage ? 3 + acceptedLanguage.length : 3;
	if (!acceptedLanguage) {
		while (cursor < value.length && /[A-Za-z0-9]/.test(value[cursor]))
			cursor += 1;
		const language = value.slice(3, cursor);
		// A whitespace-delimited token is an explicit (unsupported) language
		// label. Otherwise it is compact unlabeled content such as ```true``` or
		// ```name: value```, which the previous whole-fence parsers accepted.
		if (language && /\s/u.test(value[cursor] ?? "")) return null;
		cursor = 3;
	}
	while (cursor < value.length - 3 && /\s/u.test(value[cursor])) cursor += 1;
	let end = value.length - 3;
	while (end > cursor && /\s/u.test(value[end - 1])) end -= 1;
	return value.slice(cursor, end);
}
