/** Stored quote links are read candidates, never permission or speaker proof.
 * Follow them only inside the freshly authorized, unchanged dialogue sources. */
import { hashStableJson } from "../../runtime/context-hash";
import type { ContextSegmentEvent } from "../../types/context-object";
import type { Content } from "../../types/primitives";

export type SourceReplyReferences = NonNullable<
	Content["sourceReplyReferences"]
>;

export function sourceReplyTextHash(text: string): string {
	return hashStableJson(text.trim());
}

export function sourceReplyEventHash(event: ContextSegmentEvent): string {
	return hashStableJson({
		id: event.id,
		label: event.segment.label,
		content: event.segment.content,
		roomId: event.segment.metadata?.roomId,
		entityId: event.segment.metadata?.entityId,
	});
}

/** Changed delivery text invalidates all links. Unknown or malformed stored
 * metadata is ignored; it must never turn into an arbitrary database read. */
export function readSourceReplyReferences(
	value: unknown,
	text: string,
): SourceReplyReferences | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	if (
		record.replySha256 !== sourceReplyTextHash(text) ||
		!Array.isArray(record.sources) ||
		record.sources.length === 0
	)
		return;
	const sources: SourceReplyReferences["sources"] = [];
	for (const entry of record.sources) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
		const source = entry as Record<string, unknown>;
		if (
			typeof source.eventId !== "string" ||
			!source.eventId.startsWith("history:") ||
			typeof source.sourceSha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(source.sourceSha256)
		)
			return;
		sources.push({
			eventId: source.eventId,
			sourceSha256: source.sourceSha256,
		});
	}
	return { replySha256: record.replySha256 as string, sources };
}
