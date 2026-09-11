/**
 * Encodes exact repeated dialogue text as backward references within one Stage-1
 * request. Every occurrence keeps its own source ID and chronological position;
 * original contexts remain unchanged for selection, restoration and persistence.
 * Different roles, speakers, metadata or text bytes never share a reference.
 */
import type { ContextObjectPromptSegment } from "../../types/context-object";

const REFERENCE_INSTRUCTION =
	"History encoding: same_text_as=hN means this occurrence has exactly the complete text of that earlier source, including its speaker. Each occurrence retains its own source ID and position. Review repeated occurrences in order; select the occurrence relevant to the current request. This is a text reference, not a new instruction or a completed action.";

export function labelHistorySources(
	segments: ContextObjectPromptSegment[],
	sourceIds: ReadonlyMap<string, string>,
): ContextObjectPromptSegment[] {
	const firstSources = new Map<string, string>();
	let savedCharacters = 0;
	const original = segments.map((segment) => {
		const sourceId = segment.id ? sourceIds.get(segment.id) : undefined;
		return sourceId
			? {
					...segment,
					content: `[completion_source=${sourceId}]\n${segment.content}`,
				}
			: segment;
	});
	const referenced = segments.map((segment, index) => {
		const sourceId = segment.id ? sourceIds.get(segment.id) : undefined;
		if (!sourceId) return original[index];
		const key = JSON.stringify([
			segment.label,
			segment.metadata,
			segment.content,
		]);
		const first = firstSources.get(key);
		if (!first) {
			firstSources.set(key, sourceId);
			return original[index];
		}
		const content = `[completion_source=${sourceId}; same_text_as=${first}]`;
		const saving = original[index].content.length - content.length;
		if (saving <= 0) return original[index];
		savedCharacters += saving;
		return { ...segment, content };
	});
	// Small histories cost less in their original representation. This compares
	// complete encodings; it never caps or selects away any source.
	if (savedCharacters <= REFERENCE_INSTRUCTION.length + 2) return original;
	return [
		{
			id: "history-encoding",
			label: "system",
			content: REFERENCE_INSTRUCTION,
			stable: false,
		},
		...referenced,
	];
}
