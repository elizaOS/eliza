const MAX_DESCRIPTION_LENGTH = 160;

const PROTECTED_PATTERNS = [
	/```[\s\S]*?```/g,
	/`[^`\n]+`/g,
	/\bhttps?:\/\/[^\s)]+/g,
	/(^|[\s([{:=,])((?:\.{1,2}\/|\/|~\/)[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)/g,
	/\b[A-Z][A-Z0-9_]{2,}\b/g,
] as const;

const PHRASE_REPLACEMENTS: Array<[RegExp, string]> = [
	[/\bin order to\b/gi, "to"],
	[/\b(?:please|simply|basically|actually|currently)\b/gi, ""],
	[/\bthis (?:action|provider|evaluator) (?:will|can|should)\b/gi, ""],
	[/\bthis (?:action|provider|evaluator) is used to\b/gi, ""],
	[/\buse this (?:action|provider|evaluator)?\s*when\b/gi, "Use when"],
	[/\buse this (?:action|provider|evaluator)?\s*to\b/gi, "Use to"],
	[/\bwhen the user asks to\b/gi, "when user asks to"],
	[/\bwhen the user wants to\b/gi, "when user wants to"],
	[/\bthe user\b/gi, "user"],
	[/\bthe agent\b/gi, "agent"],
	[/\ba direct\b/gi, "direct"],
	[/\bthe current conversation\b/gi, "current convo"],
	[/\bconversation context\b/gi, "context"],
	[/\bcurrent conversation\b/gi, "current convo"],
	[/\bknowledge base\b/gi, "KB"],
	[/\bsemantic search\b/gi, "semantic search"],
	[/\bthird-party\b/gi, "3p"],
	[/\bwith an? optional\b/gi, "with optional"],
	[/\bthat are\b/gi, ""],
	[/\bthat is\b/gi, ""],
	[/\bwhich are\b/gi, ""],
	[/\bwhich is\b/gi, ""],
];

const WORD_REPLACEMENTS: Array<[RegExp, string]> = [
	[/\bmessages\b/gi, "msgs"],
	[/\bmessage\b/gi, "msg"],
	[/\binformation\b/gi, "info"],
	[/\bconfiguration\b/gi, "config"],
	[/\bparameters\b/gi, "params"],
	[/\bparameter\b/gi, "param"],
	[/\bidentifier\b/gi, "id"],
	[/\bidentifiers\b/gi, "ids"],
	[/\bapplication\b/gi, "app"],
	[/\bapplications\b/gi, "apps"],
	[/\bconversation\b/gi, "convo"],
	[/\bconversations\b/gi, "convos"],
	[/\bresponse\b/gi, "reply"],
	[/\bresponses\b/gi, "replies"],
	[/\bauthentication\b/gi, "auth"],
	[/\bauthorization\b/gi, "authz"],
	[/\bdatabase\b/gi, "DB"],
	[/\bapproximately\b/gi, "approx."],
	[/\bmaximum\b/gi, "max"],
	[/\bminimum\b/gi, "min"],
	[/\bwithout\b/gi, "without"],
];

const LEADING_VERB_REPLACEMENTS: Array<[RegExp, string]> = [
	[/^Provides\b/i, "Provide"],
	[/^Retrieves\b/i, "Get"],
	[/^Returns\b/i, "Return"],
	[/^Generates\b/i, "Generate"],
	[/^Creates\b/i, "Create"],
	[/^Updates\b/i, "Update"],
	[/^Deletes\b/i, "Delete"],
	[/^Sends\b/i, "Send"],
	[/^Extracts\b/i, "Extract"],
	[/^Identifies\b/i, "Identify"],
	[/^Summarizes\b/i, "Summarize"],
	[/^Compresses\b/i, "Compress"],
	[/^Automatically\b/i, "Auto"],
];

function normalizeWhitespace(value: string): string {
	return value.trim().split(/\s+/).filter(Boolean).join(" ");
}

function protectTechnicalSpans(value: string): {
	text: string;
	restore: (text: string) => string;
} {
	const protectedValues: string[] = [];
	let text = value;

	const protect = (span: string): string => {
		const token = `__elizaProtected${protectedValues.length}__`;
		protectedValues.push(span);
		return token;
	};

	for (const pattern of PROTECTED_PATTERNS) {
		text = text.replace(pattern, (...args: string[]) => {
			if (pattern.source.startsWith("(^|")) {
				const prefix = args[1] ?? "";
				const span = args[2] ?? "";
				return `${prefix}${protect(span)}`;
			}
			return protect(args[0] ?? "");
		});
	}

	return {
		text,
		restore: (restoredText: string) =>
			restoredText.replace(
				/__elizaProtected(\d+)__/g,
				(_match, index: string) => protectedValues[Number(index)] ?? "",
			),
	};
}

function truncateDescription(value: string): string {
	if (value.length <= MAX_DESCRIPTION_LENGTH) {
		return value;
	}

	const limit = MAX_DESCRIPTION_LENGTH - 3;
	const tokens = value.match(/\S+\s*/g) ?? [value];
	let out = "";

	for (const token of tokens) {
		const next = `${out}${token}`;
		if (next.trimEnd().length > limit) {
			break;
		}
		out = next;
	}

	const trimmed = (out || value.slice(0, limit))
		.trimEnd()
		.replace(/[\s,;:.!?-]+$/, "");

	return `${trimmed}...`;
}

/**
 * Deterministic caveman-style description compression for model-facing
 * action/provider docs. Preserves code spans, URLs, paths, commands, env vars,
 * numeric/date-like tokens, and technical terms while dropping common filler.
 */
export function compressPromptDescription(
	description: string | undefined,
): string {
	if (typeof description !== "string" || !description.trim()) {
		return "";
	}

	const { text, restore } = protectTechnicalSpans(description);
	let compact = normalizeWhitespace(text)
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\s+[-–—]\s+/g, " - ")
		.replace(/[–—]/g, "-")
		.replace(/\s*;\s*/g, ". ");

	for (const [pattern, replacement] of PHRASE_REPLACEMENTS) {
		compact = compact.replace(pattern, replacement);
	}
	for (const [pattern, replacement] of WORD_REPLACEMENTS) {
		compact = compact.replace(pattern, replacement);
	}

	compact = normalizeWhitespace(compact)
		.replace(/\s+([,.;:!?])/g, "$1")
		.replace(/([.!?]){2,}/g, "$1")
		.replace(/\s*,\s*/g, ", ")
		.replace(/\s*\.\s*/g, ". ")
		.replace(/\(\s+/g, "(")
		.replace(/\s+\)/g, ")")
		.replace(/\s+\/\s+/g, "/")
		.trim();

	for (const [pattern, replacement] of LEADING_VERB_REPLACEMENTS) {
		compact = compact.replace(pattern, replacement);
	}

	compact = restore(normalizeWhitespace(compact));

	return truncateDescription(compact);
}
