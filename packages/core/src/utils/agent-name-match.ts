/**
 * Single source of truth for matching an agent's name in message text.
 * Three call paths must branch on the same ground truth — the Stage-1 prompt
 * tier and engagement addressing gate (services/message.ts), the addressing
 * gate's self-name set (runtime/addressed-to.ts), and the shouldRespond
 * mention check (features/basic-capabilities) — so the name normalization,
 * the distinctive-token expansion, and the boundary-anchored matcher live
 * here once. Live 2026-08-22: two divergent copies of this matcher classified
 * "nubilio whats the setting …" as ambient for agent "remilio nubilio"
 * because only one copy expanded multi-word names into tokens.
 */

import { toWellFormedUnicode } from "./well-formed.ts";

/** Escapes regex metacharacters so a name can be embedded in a pattern. */
export function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Canonical name normalization: trimmed, lowercased, leading @ stripped. */
export function normalizeName(value: string): string {
	return value.trim().toLowerCase().replace(/^@/, "");
}

/**
 * Expands a (possibly multi-word) name into the strings that count as
 * addressing it: the full name plus each whitespace-separated token of at
 * least 4 characters ("remilio nubilio" answers to "nubilio"). Shorter
 * tokens stay excluded — fragments like "al" or "bot" would match ordinary
 * prose.
 */
export function distinctiveNameTokens(name: string): string[] {
	const candidate = name.trim();
	if (!candidate) {
		return [];
	}
	const tokens = new Set<string>([candidate]);
	for (const token of candidate.split(/\s+/u)) {
		if (token.length >= 4) {
			tokens.add(token);
		}
	}
	return [...tokens];
}

/**
 * True when the text mentions the agent by any of its names or distinctive
 * name tokens, on non-alphanumeric boundaries, case-insensitively. The text
 * is sanitized to well-formed Unicode first so a lone surrogate from
 * arbitrary connector input cannot break the match.
 */
export function textContainsAgentName(
	text: string | undefined,
	names: Array<string | null | undefined>,
): boolean {
	if (!text) {
		return false;
	}

	const candidates = new Set<string>();
	for (const name of names) {
		for (const token of distinctiveNameTokens(name ?? "")) {
			candidates.add(token);
		}
	}

	const safeText = toWellFormedUnicode(text);
	return [...candidates].some((candidate) => {
		const pattern = new RegExp(
			`(^|[^\\p{L}\\p{N}])${escapeRegex(candidate)}(?=$|[^\\p{L}\\p{N}])`,
			"iu",
		);
		return pattern.test(safeText);
	});
}
