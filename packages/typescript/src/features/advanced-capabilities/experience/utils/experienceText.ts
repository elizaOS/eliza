import type { ExperienceService } from "../service.ts";
import type { Experience } from "../types.ts";

const DUPLICATE_EXPERIENCE_LIMIT = 5;
const DUPLICATE_JACCARD_THRESHOLD = 0.45;
const DUPLICATE_CONTAINMENT_THRESHOLD = 0.65;
const DUPLICATE_SHARED_TERM_THRESHOLD = 4;
const STOP_WORDS = new Set([
	"about",
	"after",
	"again",
	"always",
	"before",
	"being",
	"because",
	"could",
	"every",
	"from",
	"into",
	"learned",
	"needs",
	"that",
	"their",
	"them",
	"then",
	"there",
	"these",
	"this",
	"through",
	"using",
	"what",
	"when",
	"with",
	"without",
]);
const MAX_EXPERIENCE_KEYWORDS = 12;

export function sanitizeExperienceText(text: string): string {
	if (!text) return "Unknown context";

	return text
		.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "[EMAIL]")
		.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[IP]")
		.replace(/\/Users\/[^/\s]+/g, "/Users/[USER]")
		.replace(/\/home\/[^/\s]+/g, "/home/[USER]")
		.replace(
			/\b(?:sk|pk|rk|gsk|ghp|gho|ghu|ghs|github_pat|xox[baprs])-?[A-Za-z0-9_-]{12,}\b/gi,
			"[TOKEN]",
		)
		.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[TOKEN]")
		.replace(
			/\b(user|person|someone|they)\s+(said|asked|told|mentioned)/gi,
			"when asked",
		)
		.substring(0, 200);
}

export function detectExperienceDomain(text: string): string {
	const domains: Record<string, string[]> = {
		shell: ["command", "terminal", "bash", "shell", "execute", "script", "cli"],
		coding: [
			"code",
			"function",
			"variable",
			"syntax",
			"programming",
			"debug",
			"typescript",
			"javascript",
		],
		system: [
			"file",
			"directory",
			"process",
			"memory",
			"cpu",
			"system",
			"install",
			"package",
		],
		network: [
			"http",
			"api",
			"request",
			"response",
			"url",
			"network",
			"fetch",
			"curl",
		],
		data: ["json", "csv", "database", "query", "data", "sql", "table"],
		ai: ["model", "llm", "embedding", "prompt", "token", "inference"],
	};

	const lowerText = text.toLowerCase();

	for (const [domain, keywords] of Object.entries(domains)) {
		if (keywords.some((keyword) => lowerText.includes(keyword))) {
			return domain;
		}
	}

	return "general";
}

export function extractExperienceKeywords(
	parts: Array<string | string[] | null | undefined>,
	limit = MAX_EXPERIENCE_KEYWORDS,
): string[] {
	const keywords = new Map<string, number>();

	for (const part of parts) {
		const values = Array.isArray(part) ? part : [part];
		for (const value of values) {
			if (typeof value !== "string" || value.trim().length === 0) {
				continue;
			}
			for (const token of tokenizeForKeywordExtraction(value)) {
				keywords.set(token, (keywords.get(token) ?? 0) + 1);
			}
		}
	}

	return [...keywords.entries()]
		.sort((left, right) => {
			const countDelta = right[1] - left[1];
			return countDelta !== 0 ? countDelta : left[0].localeCompare(right[0]);
		})
		.slice(0, limit)
		.map(([keyword]) => keyword);
}

export async function findDuplicateExperienceByLearning(
	experienceService: ExperienceService,
	learning: string,
): Promise<Experience | null> {
	const similar = await experienceService.findSimilarExperiences(
		learning,
		DUPLICATE_EXPERIENCE_LIMIT,
	);

	return (
		similar.find((experience) =>
			isDuplicateLearning(learning, experience.learning),
		) ??
		(await experienceService.listExperiences({ limit: 200 })).find(
			(experience) => isDuplicateLearning(learning, experience.learning),
		) ??
		null
	);
}

export function isDuplicateLearning(a: string, b: string): boolean {
	const normalizedA = normalizeTextForDuplicateComparison(a);
	const normalizedB = normalizeTextForDuplicateComparison(b);
	if (!normalizedA || !normalizedB) {
		return false;
	}
	if (normalizedA === normalizedB) {
		return true;
	}
	if (
		Math.min(normalizedA.length, normalizedB.length) >= 24 &&
		(normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA))
	) {
		return true;
	}

	const aTokens = tokenizeForDuplicateComparison(normalizedA);
	const bTokens = tokenizeForDuplicateComparison(normalizedB);
	if (aTokens.size < 4 || bTokens.size < 4) {
		return false;
	}

	const overlap = [...aTokens].filter((token) => bTokens.has(token)).length;
	const union = new Set([...aTokens, ...bTokens]).size;
	const jaccard = union > 0 ? overlap / union : 0;
	const containment = overlap / Math.min(aTokens.size, bTokens.size);

	return (
		jaccard >= DUPLICATE_JACCARD_THRESHOLD ||
		containment >= DUPLICATE_CONTAINMENT_THRESHOLD ||
		(overlap >= DUPLICATE_SHARED_TERM_THRESHOLD && containment >= 0.4)
	);
}

function normalizeTextForDuplicateComparison(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function tokenizeForDuplicateComparison(text: string): Set<string> {
	return new Set(
		text
			.split(" ")
			.map((token) => token.trim())
			.map(normalizeDuplicateToken)
			.filter((token) => token.length > 3 && !STOP_WORDS.has(token)),
	);
}

function normalizeDuplicateToken(token: string): string {
	if (token.length > 6 && token.endsWith("ing")) {
		return token.slice(0, -3);
	}
	if (token.length > 5 && token.endsWith("ed")) {
		return token.slice(0, -2);
	}
	if (token.length > 4 && token.endsWith("s")) {
		return token.slice(0, -1);
	}
	return token;
}

function tokenizeForKeywordExtraction(text: string): string[] {
	return normalizeTextForDuplicateComparison(text)
		.split(" ")
		.map((token) => token.trim())
		.filter((token) => token.length > 3 && !STOP_WORDS.has(token));
}
