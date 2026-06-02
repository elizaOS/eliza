import { looksLikeTrainingCutoffLeak } from "./cutoff-leak-detector";
import { looksLikeFabricatedModeration } from "./fabricated-moderation-detector";
import { looksLikeRefusal } from "./refusal-detector";

export function looksLikeStage1HonestyViolation(
	text: string | undefined | null,
): boolean {
	return (
		looksLikeRefusal(text) ||
		looksLikeTrainingCutoffLeak(text) ||
		looksLikeFabricatedModeration(text)
	);
}

export function looksLikeNonRefusalStage1HonestyViolation(
	text: string | undefined | null,
): boolean {
	return (
		looksLikeTrainingCutoffLeak(text) || looksLikeFabricatedModeration(text)
	);
}
