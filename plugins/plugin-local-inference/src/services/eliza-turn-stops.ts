/**
 * Defines the control markers that terminate an Eliza chat turn and merges
 * them with caller-provided local-inference stop sequences without duplicates.
 */

export const ELIZA_TURN_STOP_SEQUENCES = [
	"<end_of_turn>",
	"<start_of_turn>",
	"<endoftext>",
] as const;

export function mergeElizaTurnStopSequences(
	requested: readonly string[] | undefined,
): string[] {
	return Array.from(
		new Set([
			...(requested ?? []).filter((stop) => stop.length > 0),
			...ELIZA_TURN_STOP_SEQUENCES,
		]),
	);
}
