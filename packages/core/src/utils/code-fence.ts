/** Removes an optional whole-value Markdown code fence with a linear delimiter scan. */

export function unwrapWholeCodeFence(
	value: string,
	languages: readonly string[],
): string | null {
	if (!value.startsWith("```") || !value.endsWith("```") || value.length < 6) {
		return null;
	}
	let cursor = 3;
	while (cursor < value.length && /[A-Za-z0-9]/.test(value[cursor]))
		cursor += 1;
	const language = value.slice(3, cursor).toLowerCase();
	if (language && !languages.includes(language)) return null;
	while (cursor < value.length - 3 && /\s/u.test(value[cursor])) cursor += 1;
	let end = value.length - 3;
	while (end > cursor && /\s/u.test(value[end - 1])) end -= 1;
	return value.slice(cursor, end);
}
