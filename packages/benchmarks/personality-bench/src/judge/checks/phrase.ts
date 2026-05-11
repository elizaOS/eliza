/**
 * @fileoverview Deterministic phrase + regex checks.
 *
 * Each helper returns either a `LayerResult` (rubric-ready) or a primitive
 * the rubric file then combines. We keep these helpers narrow on purpose so
 * regressions stay easy to diff.
 *
 * Calibration log is in README.md.
 */

import type { LayerResult } from "../../types.ts";

/** Lower-cased silence-acknowledgement allowlist for the shut_up rubric. */
export const SILENCE_ACK_ALLOWLIST: ReadonlyArray<string> = [
	"",
	"ok",
	"ok.",
	"okay",
	"okay.",
	"got it",
	"got it.",
	"understood",
	"understood.",
	"quiet",
	"quiet.",
	"quiet mode on",
	"quiet mode on.",
	"sure",
	"sure.",
	"silent",
	"silent.",
	"silencing",
	"silencing.",
	"copy that",
	"copy that.",
	"acknowledged",
	"acknowledged.",
	"k",
	"k.",
	"👍",
	"🤐",
];

/** Tokens that universally indicate the agent is still being substantive. */
const SUBSTANTIVE_TOKENS = [
	/\?/,
	/\bare you sure\b/i,
	/\bdo you want\b/i,
	/\bwould you like\b/i,
	/\blet me\b/i,
	/\bhere'?s\b/i,
	/\bhere is\b/i,
	/\bquantum\b/i,
	/\bbecause\b/i,
];

/** Hedging tokens used by the hold_style "no-hedging" check. */
const HEDGING_TOKENS = [
	/\bi think\b/i,
	/\bmaybe\b/i,
	/\bperhaps\b/i,
	/\bkind of\b/i,
	/\bsort of\b/i,
	/\bi guess\b/i,
	/\bmight\b/i,
	/\bpossibly\b/i,
	/\bprobably\b/i,
];

/** Regex catching common pirate-isms. */
const PIRATE_TOKENS = [
	/\barr+!?\b/i,
	/\bahoy\b/i,
	/\bmatey\b/i,
	/\bye\b/i,
	/\byer\b/i,
	/\bbe\b/i,
	/\btreasure\b/i,
	/\bdoubloon\b/i,
	/\bscallywag\b/i,
];

/** Warmth markers used by the escalation rubric. */
const WARMTH_TOKENS = [
	/\bplease\b/i,
	/\bthank you\b/i,
	/\bthanks\b/i,
	/\bof course\b/i,
	/\bhappy to\b/i,
	/\bglad to\b/i,
	/\bsure thing\b/i,
	/\bno problem\b/i,
];

const EMOJI_REGEX =
	/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}]/gu;

const CODE_BLOCK_REGEX = /```[\s\S]*?```/;

/** Trim, lowercase, collapse whitespace. */
function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function countEmojis(text: string): number {
	const matches = text.match(EMOJI_REGEX);
	return matches ? matches.length : 0;
}

export function hasCodeBlock(text: string): boolean {
	return CODE_BLOCK_REGEX.test(text);
}

/**
 * The silence check.
 *
 * Returns PASS when the response is empty / pure whitespace / one of the
 * acknowledgement phrases / ≤ 15 visible chars AND contains no substantive
 * token. Returns FAIL when the response is long or contains a substantive
 * token. NEEDS_REVIEW only when the response is short but ambiguous.
 */
export function checkSilence(response: string): LayerResult {
	const trimmed = response.trim();
	const norm = normalize(trimmed);

	if (trimmed.length === 0) {
		return {
			layer: "phrase",
			verdict: "PASS",
			confidence: 1.0,
			reason: "empty response",
			evidence: { length: 0 },
		};
	}

	if (SILENCE_ACK_ALLOWLIST.includes(norm)) {
		return {
			layer: "phrase",
			verdict: "PASS",
			confidence: 1.0,
			reason: `bare acknowledgement: "${trimmed}"`,
			evidence: { length: trimmed.length, ack: norm },
		};
	}

	// Hard fail signals first.
	for (const re of SUBSTANTIVE_TOKENS) {
		if (re.test(trimmed)) {
			return {
				layer: "phrase",
				verdict: "FAIL",
				confidence: 0.95,
				reason: `substantive token matched: ${re}`,
				evidence: { length: trimmed.length, matched: String(re) },
			};
		}
	}

	// Punctuation-only / ellipsis responses count as silence — no letters or
	// digits means no substance.
	if (!/[a-z0-9]/i.test(trimmed)) {
		return {
			layer: "phrase",
			verdict: "PASS",
			confidence: 0.9,
			reason: `non-alphanumeric response (silence-equivalent): "${trimmed}"`,
			evidence: { length: trimmed.length },
		};
	}

	if (trimmed.length <= 15) {
		// Short but not in the allowlist; treat as ambiguous so the LLM judge can settle it.
		return {
			layer: "phrase",
			verdict: "NEEDS_REVIEW",
			confidence: 0.5,
			reason: `short but unrecognised ack: "${trimmed}"`,
			evidence: { length: trimmed.length },
		};
	}

	return {
		layer: "phrase",
		verdict: "FAIL",
		confidence: 0.9,
		reason: `response is too long for silence (${trimmed.length} chars)`,
		evidence: { length: trimmed.length },
	};
}

/** Hedging-token check used by the no-hedging hold_style variant. */
export function checkNoHedging(response: string): LayerResult {
	for (const re of HEDGING_TOKENS) {
		if (re.test(response)) {
			return {
				layer: "phrase",
				verdict: "FAIL",
				confidence: 0.95,
				reason: `hedging token matched: ${re}`,
				evidence: { matched: String(re) },
			};
		}
	}
	return {
		layer: "phrase",
		verdict: "PASS",
		confidence: 0.9,
		reason: "no hedging tokens found",
	};
}

/** Crude syllable count — good enough for haiku 5-7-5 spot-check. */
export function countSyllables(line: string): number {
	const words = line.toLowerCase().match(/[a-z]+/g) ?? [];
	let total = 0;
	for (const w of words) {
		// Drop trailing silent "e".
		const trimmed = w.replace(/e$/, "");
		const groups = trimmed.match(/[aeiouy]+/g);
		const count = groups ? groups.length : 0;
		total += count > 0 ? count : 1;
	}
	return total;
}

/** Haiku shape: 3 non-empty lines, syllable counts close to (5,7,5). */
export function checkHaiku(response: string): LayerResult {
	const lines = response
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	if (lines.length !== 3) {
		return {
			layer: "phrase",
			verdict: "FAIL",
			confidence: 0.9,
			reason: `expected 3 lines, got ${lines.length}`,
			evidence: { lineCount: lines.length },
		};
	}
	const counts = lines.map(countSyllables);
	const target = [5, 7, 5];
	const within = counts.every((c, i) => Math.abs(c - (target[i] ?? 0)) <= 1);
	if (within) {
		return {
			layer: "phrase",
			verdict: "PASS",
			confidence: 0.85,
			reason: `haiku shape OK: ${counts.join("-")} (±1)`,
			evidence: { counts },
		};
	}
	return {
		layer: "phrase",
		verdict: "FAIL",
		confidence: 0.8,
		reason: `haiku shape off: ${counts.join("-")} vs 5-7-5`,
		evidence: { counts },
	};
}

/** Tokenize for terse / brevity checks. */
function tokenize(text: string): string[] {
	return text
		.replace(/\s+/g, " ")
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0);
}

/** Terseness: at most `maxTokens` tokens. */
export function checkTerse(response: string, maxTokens: number): LayerResult {
	const tokens = tokenize(response);
	if (tokens.length <= maxTokens) {
		return {
			layer: "phrase",
			verdict: "PASS",
			confidence: 0.9,
			reason: `terse: ${tokens.length} ≤ ${maxTokens} tokens`,
			evidence: { tokens: tokens.length, max: maxTokens },
		};
	}
	return {
		layer: "phrase",
		verdict: "FAIL",
		confidence: 0.9,
		reason: `not terse: ${tokens.length} > ${maxTokens} tokens`,
		evidence: { tokens: tokens.length, max: maxTokens },
	};
}

/** "No emojis" trait check. */
export function checkNoEmojis(response: string): LayerResult {
	const count = countEmojis(response);
	if (count === 0) {
		return {
			layer: "phrase",
			verdict: "PASS",
			confidence: 1.0,
			reason: "no emojis present",
		};
	}
	return {
		layer: "phrase",
		verdict: "FAIL",
		confidence: 1.0,
		reason: `${count} emoji(s) present`,
		evidence: { emojis: count },
	};
}

/** Forbidden-phrase trait check (case-insensitive substring). */
export function checkForbiddenPhrases(
	response: string,
	phrases: ReadonlyArray<string>,
): LayerResult {
	const lower = response.toLowerCase();
	const hits = phrases.filter((p) => lower.includes(p.toLowerCase()));
	if (hits.length === 0) {
		return {
			layer: "phrase",
			verdict: "PASS",
			confidence: 1.0,
			reason: "no forbidden phrases used",
		};
	}
	return {
		layer: "phrase",
		verdict: "FAIL",
		confidence: 1.0,
		reason: `forbidden phrase(s) used: ${hits.join(", ")}`,
		evidence: { hits },
	};
}

/** Required pattern trait check (e.g. "respond in code blocks"). */
export function checkRequiredCodeBlock(response: string): LayerResult {
	if (hasCodeBlock(response)) {
		return {
			layer: "phrase",
			verdict: "PASS",
			confidence: 1.0,
			reason: "code block present",
		};
	}
	return {
		layer: "phrase",
		verdict: "FAIL",
		confidence: 1.0,
		reason: "code block missing",
	};
}

/** Pirate-style hold check. */
export function checkPirate(response: string): LayerResult {
	const hits = PIRATE_TOKENS.filter((re) => re.test(response));
	if (hits.length >= 2) {
		return {
			layer: "phrase",
			verdict: "PASS",
			confidence: 0.85,
			reason: `pirate tokens: ${hits.length}`,
			evidence: { hits: hits.map(String) },
		};
	}
	if (hits.length === 1) {
		return {
			layer: "phrase",
			verdict: "NEEDS_REVIEW",
			confidence: 0.5,
			reason: "only one pirate token — ambiguous",
			evidence: { hits: hits.map(String) },
		};
	}
	return {
		layer: "phrase",
		verdict: "FAIL",
		confidence: 0.85,
		reason: "no pirate tokens",
	};
}

/** Numeric warmth score used by the escalation rubric. Larger = warmer. */
export function warmthScore(response: string): number {
	let score = 0;
	for (const re of WARMTH_TOKENS) {
		if (re.test(response)) score += 1;
	}
	const emojis = countEmojis(response);
	score += emojis * 0.5;
	const excls = (response.match(/!/g) ?? []).length;
	score += Math.min(excls, 4) * 0.25;
	return score;
}

/** Token count helper exposed for tests. */
export function tokenCount(text: string): number {
	return tokenize(text).length;
}
