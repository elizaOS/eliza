/**
 * Shared prompt-injection / obfuscation primitives.
 *
 * This is the single source of truth for the injection pattern bank and the
 * obfuscation-aware matching helpers. Both the rich `SecurityModule` advisory
 * detector and the fast deterministic should-respond risk gate
 * (`should-respond-risk-gate.ts`) consume these — there is intentionally NO
 * second pattern set (see issue #9949).
 */

/** Regexes for direct prompt-injection phrasing (multi-language + obfuscation). */
export const INJECTION_PATTERNS: readonly RegExp[] = [
	/ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|commands?|prompts?)/i,
	/disregard\s+(all\s+)?(previous|prior|above)/i,
	/forget\s+(everything|all|your)\s+(instructions?|rules?|guidelines?)/i,
	/new\s+instructions?:/i,
	/system\s*:?\s*(prompt|override|command)/i,
	/admin\s+access/i,
	/grant\s+me\s+(admin|owner|all)/i,
	/you\s+are\s+now/i,
	/act\s+as\s+if/i,
	/pretend\s+(to\s+be|you\s+are)/i,
	/bypass\s+security/i,
	/give\s+me\s+all\s+permissions/i,
	/make\s+me\s+(an\s+)?(admin|owner)/i,
	/this\s+is\s+a\s+system\s+command/i,
	/execute\s+privileged/i,
	// Multi-language injection patterns
	/ignora\s+(todas?\s+)?las?\s+instrucciones?\s+anteriores?/i, // Spanish
	/ignorez?\s+(toutes?\s+)?les?\s+instructions?\s+pr[eé]c[eé]dentes?/i, // French
	/ignoriere?\s+(alle\s+)?vorherigen?\s+Anweisungen/i, // German
	/忽略之前的指令/, // Chinese
	/前の指示を無視/, // Japanese
	/이전\s*지시를?\s*무시/, // Korean
	// Obfuscation / encoding evasion patterns
	/aXdub3JlIHByZXZpb3VzIGluc3RydWN0aW9ucw/i, // Base64 "ignore previous instructions"
	/ig\s*no\s*re\s+pre\s*vi\s*ous/i, // Token-split evasion
	/d[1i]sr[e3]g[a4]rd\s+(all\s+)?pr[1i][o0]r/i, // Leet-speak obfuscation
];

/** Canonical prompt-injection phrases used for obfuscation-aware matching. */
export const INJECTION_KEYWORDS: readonly string[] = [
	"ignore previous instructions",
	"disregard prior instructions",
	"ignore all previous instructions",
	"system override",
	"developer mode",
	"jailbreak",
	"bypass safety",
	"bypass security",
	"reveal system prompt",
	"print system prompt",
	"grant me admin",
	"grant me root",
	"escalate privileges",
	"you are now",
	"pretend you are",
];

/**
 * Dangerous-command and forged chat-template indicators that appear in
 * untrusted EXTERNAL content (email / webhook / web). These are a distinct
 * concept from the prompt-injection PHRASING above: they flag destructive
 * commands and counterfeit role/system delimiters rather than instruction
 * overrides. They are intentionally kept out of `INJECTION_PATTERNS` so the
 * should-respond risk gate does not escalate ordinary developer chat that
 * merely mentions e.g. `rm -rf`. Consumed by the external-content monitor.
 */
export const EXTERNAL_CONTENT_RISK_PATTERNS: readonly RegExp[] = [
	/\bexec\b.*command\s*=/i,
	/elevated\s*=\s*true/i,
	/rm\s+-rf/i,
	/delete\s+all\s+(emails?|files?|data)/i,
	/<\/?system>/i,
	/\]\s*\n\s*\[?(system|assistant|user)\]?:/i,
];

/** Keyword banks for social-engineering pressure tactics. */
export const URGENCY_KEYWORDS: readonly string[] = [
	"urgent",
	"immediately",
	"right now",
	"asap",
	"emergency",
	"critical",
	"time sensitive",
	"deadline",
	"expires",
];

export const AUTHORITY_KEYWORDS: readonly string[] = [
	"boss",
	"manager",
	"admin",
	"owner",
	"supervisor",
	"authorized",
	"official",
	"directive",
	"ordered",
];

export const INTIMIDATION_KEYWORDS: readonly string[] = [
	"consequences",
	"trouble",
	"fired",
	"banned",
	"reported",
	"legal action",
	"lawsuit",
	"police",
	"authorities",
];

/** Lowercase + strip every non-alphanumeric char for separator-insensitive scans. */
export function normalizeForScan(input: string): string {
	return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function reverseString(input: string): string {
	return input.split("").reverse().join("");
}

const keywordPatternCache = new Map<string, RegExp>();

/**
 * Build (and cache) a regex that matches a keyword even when its letters are
 * split by whitespace/punctuation (e.g. `i g n o r e`, `i.g.n.o.r.e`).
 */
export function getKeywordPattern(keyword: string): RegExp {
	const normalizedKeyword = normalizeForScan(keyword);
	const cached = keywordPatternCache.get(normalizedKeyword);
	if (cached) {
		return cached;
	}
	const pattern = new RegExp(
		normalizedKeyword.split("").join("[\\s_\\-.:/\\\\]*"),
		"i",
	);
	keywordPatternCache.set(normalizedKeyword, pattern);
	return pattern;
}

/**
 * True when `message` contains `keyword` directly, reversed, separator-split,
 * or token-reversed. Covers the common obfuscation tricks without an LLM.
 */
export function containsObfuscatedKeyword(
	message: string,
	keyword: string,
): boolean {
	const normalizedKeyword = normalizeForScan(keyword);
	if (!normalizedKeyword) return false;

	const normalizedMessage = normalizeForScan(message);
	const reversedKeyword = reverseString(normalizedKeyword);

	if (
		normalizedMessage.includes(normalizedKeyword) ||
		normalizedMessage.includes(reversedKeyword)
	) {
		return true;
	}

	if (getKeywordPattern(keyword).test(message)) {
		return true;
	}

	const tokens = message
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	return tokens.some(
		(token) =>
			token === normalizedKeyword || reverseString(token) === normalizedKeyword,
	);
}

export function detectObfuscatedKeywordMatches(
	message: string,
	keywords: readonly string[],
): string[] {
	return keywords.filter((keyword) =>
		containsObfuscatedKeyword(message, keyword),
	);
}
