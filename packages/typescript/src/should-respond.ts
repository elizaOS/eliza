const EXPLICIT_SELF_MODIFICATION_PATTERNS = [
	/\b(?:update|change|modify|adjust|tweak|revise|refresh|set)\s+(?:(?:your|ur|its)\s+)?(?:personality|character|tone|voice|style|behavior|behaviour|response(?:s| style)?|how\s+you\s+respond|way\s+you\s+respond)\b/i,
	/\b(?:update|change|modify|adjust|tweak|revise|refresh|set)\s+(?:the\s+|this\s+)?(?:agent|assistant|bot)(?:'s)?\s+(?:personality|character|tone|voice|style|behavior|behaviour|response(?:\s+style)?)\b/i,
	/\b(?:change|update|modify|adjust|set)\s+(?:your\s+)?response\s+style\b/i,
	/\b(?:change|update|modify|adjust|set)\s+how\s+you\s+(?:respond|reply|sound|talk)\b/i,
];

export function isExplicitSelfModificationRequest(text: string): boolean {
	if (typeof text !== "string") {
		return false;
	}

	const normalized = text.trim();
	if (normalized.length === 0) {
		return false;
	}

	return EXPLICIT_SELF_MODIFICATION_PATTERNS.some((pattern) =>
		pattern.test(normalized),
	);
}
