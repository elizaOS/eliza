import { looksLikeTrainingCutoffLeak } from "./cutoff-leak-detector";
import { looksLikeFabricatedModeration } from "./fabricated-moderation-detector";
import { looksLikeRefusal } from "./refusal-detector";

function normalizeForActionNarration(text: string): string {
	return text
		.toLowerCase()
		.replace(/[`*_~[\](){}>#✅]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Stage 1 is allowed to answer directly only when its text is the answer. It
 * must not narrate work that only a planner/tool turn can actually perform.
 */
export function looksLikeUnexecutedActionNarration(
	text: string | undefined | null,
): boolean {
	if (typeof text !== "string") return false;
	const normalized = normalizeForActionNarration(text);
	if (!normalized) return false;

	if (
		/^(?:i(?:'|’)m|i am|i(?:'|’)ll|i will|let me)\s+(?:work on|check|fetch|search|look (?:up|into)|verify|test|build|deploy|fix|start|run|spawn)\b/u.test(
			normalized,
		)
	) {
		return true;
	}
	if (
		/^(?:working on|checking|fetching|searching|looking (?:up|into)|verifying|testing|building|deploying|fixing|starting|running|spawning)\s+(?:a|an|the|that|this|it|for|now|live|http\b|https?:|deploy|deployment|site|app|url|endpoint|page|test|tests|build|sub-?agent|coding)\b/u.test(
			normalized,
		)
	) {
		return true;
	}
	if (
		/^(?:one sec|one moment|give me a sec|hold on|please hold|be right back|almost done|wrapping it up)\b/u.test(
			normalized,
		)
	) {
		return true;
	}
	if (
		/\bspawning\s+(?:a|the)?\s*(?:coding\s+)?sub-?agent\b/u.test(normalized)
	) {
		return true;
	}
	if (
		/^(?:verified|confirmed|checked|tested)\s+(?:live|the live|http\b|https?:|deployment|deploy|401\b|402\b)/u.test(
			normalized,
		)
	) {
		return true;
	}
	if (
		/^(?:app|site|url|endpoint|page)\b.*\b(?:loads|returns|responds)\b.*\bhttp\s*200\b/u.test(
			normalized,
		)
	) {
		return true;
	}

	return false;
}

export function looksLikeStage1HonestyViolation(
	text: string | undefined | null,
): boolean {
	return (
		looksLikeRefusal(text) ||
		looksLikeTrainingCutoffLeak(text) ||
		looksLikeFabricatedModeration(text) ||
		looksLikeUnexecutedActionNarration(text)
	);
}

export function looksLikeNonRefusalStage1HonestyViolation(
	text: string | undefined | null,
): boolean {
	return (
		looksLikeTrainingCutoffLeak(text) ||
		looksLikeFabricatedModeration(text) ||
		looksLikeUnexecutedActionNarration(text)
	);
}
