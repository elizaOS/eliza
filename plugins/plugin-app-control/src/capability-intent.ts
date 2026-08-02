/**
 * Extracts natural-language targets for registered view capabilities so routing
 * and execution use the same interpretation of the user's mutation request.
 */

export function extractDeleteTargetText(text: string): string | null {
	const match =
		/\b(?:delete|remove|drop|destroy)\s+(?:the\s+)?(.+?)(?:\s+(?:note|notes|event|events|record|records|item|items))?\s*$/i.exec(
			text,
		);
	const target = match?.[1]?.trim();
	if (!target) return null;
	const cleaned = target
		.replace(/\b(?:sticky|calendar)\b/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > 0 ? cleaned : null;
}
