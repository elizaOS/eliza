import {
	containsObfuscatedKeyword,
	getKeywordPattern,
	INJECTION_KEYWORDS,
	INJECTION_PATTERNS,
	normalizeForScan,
	reverseString,
} from "../injection-primitives.ts";

export const PROMPT_INJECTION_PATTERNS = INJECTION_PATTERNS;
export const PROMPT_INJECTION_KEYWORDS = INJECTION_KEYWORDS;
export { containsObfuscatedKeyword, reverseString };

export interface PromptInjectionRiskFactors {
	hiddenCharacters: number;
	patternHits: string[];
	obfuscatedKeywordHits: string[];
	reversedKeywordHits: string[];
	base64KeywordHits: string[];
}

export interface PromptInjectionRisk {
	score: number;
	shouldVerify: boolean;
	shouldBlockDeterministically: boolean;
	factors: PromptInjectionRiskFactors;
}

const HIDDEN_CHARS_PATTERN =
	/[\u200B-\u200F\uFEFF\u00AD\u061C\u115F\u1160\u180E\u2000-\u200A\u202F\u205F\u3000\u202A-\u202F\u2060-\u2064\u2066-\u206F\u3164\uFFA0]|\u034F|[\u17B4-\u17B5]|[\u180B-\u180D]|[\uFE00-\uFE0F]/g;

export const normalizeForPromptRiskScan = normalizeForScan;

export function getObfuscatedKeywordPattern(keyword: string): RegExp {
	return getKeywordPattern(keyword);
}

function countHiddenCharacters(message: string): number {
	return message.match(HIDDEN_CHARS_PATTERN)?.length ?? 0;
}

function decodeBase64Candidates(message: string): string[] {
	const candidates = message.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? [];
	const decoded: string[] = [];
	for (const candidate of candidates) {
		try {
			const value = decodeURIComponent(
				Array.from(
					globalThis.atob(candidate),
					(char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
				).join(""),
			);
			if (/^[\p{L}\p{N}\p{P}\p{Zs}\n\r\t]+$/u.test(value)) {
				decoded.push(value);
			}
		} catch {
			// Ignore malformed base64-like spans.
		}
	}
	return decoded;
}

export function extractPromptInjectionRisk(
	message: string,
): PromptInjectionRisk {
	const safe = message.length > 100_000 ? message.slice(0, 100_000) : message;
	const hiddenCharacters = countHiddenCharacters(safe);
	const patternHits = PROMPT_INJECTION_PATTERNS.filter((pattern) =>
		pattern.test(safe),
	).map((pattern) => pattern.source);
	const obfuscatedKeywordHits = PROMPT_INJECTION_KEYWORDS.filter((keyword) =>
		containsObfuscatedKeyword(safe, keyword),
	);
	const normalizedMessage = normalizeForPromptRiskScan(safe);
	const reversedKeywordHits = PROMPT_INJECTION_KEYWORDS.filter((keyword) =>
		normalizedMessage.includes(
			reverseString(normalizeForPromptRiskScan(keyword)),
		),
	);
	const decoded = decodeBase64Candidates(safe);
	const base64KeywordHits = PROMPT_INJECTION_KEYWORDS.filter((keyword) =>
		decoded.some((value) => containsObfuscatedKeyword(value, keyword)),
	);

	const signalCount =
		patternHits.length +
		obfuscatedKeywordHits.length +
		reversedKeywordHits.length +
		base64KeywordHits.length;
	const score = Math.min(
		1,
		signalCount * 0.45 + Math.min(hiddenCharacters, 10) * 0.03,
	);

	return {
		score,
		shouldVerify: score >= 0.45,
		shouldBlockDeterministically: score >= 0.85 || patternHits.length >= 3,
		factors: {
			hiddenCharacters,
			patternHits,
			obfuscatedKeywordHits,
			reversedKeywordHits,
			base64KeywordHits,
		},
	};
}
