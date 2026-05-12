import type { Memory } from "../types/index.ts";

const SYNTHETIC_SOURCE_RE = /\b(?:compaction|compactor|synthetic|summary)\b/i;
const SYNTHETIC_MARKER_RE =
	/^\[(?:conversation|system)\s+(?:summary|hybrid-ledger|state)(?:\s+\[[^\]]+\])?\]/i;

export function isSyntheticConversationArtifactText(text: string): boolean {
	const trimmed = text.trim();
	return (
		SYNTHETIC_MARKER_RE.test(trimmed) ||
		/^compacted prior planner trajectory steps/i.test(trimmed) ||
		/^#{1,3}\s*Conversation Summary\b/i.test(trimmed) ||
		/\b(?:conversation summary|compacted prior planner|compactor|summary mode)\b/i.test(
			trimmed,
		)
	);
}

export function isSyntheticConversationArtifactMemory(
	memory: Pick<Memory, "content" | "metadata">,
): boolean {
	const metadata =
		memory.metadata && typeof memory.metadata === "object"
			? (memory.metadata as Record<string, unknown>)
			: {};
	const source = typeof metadata.source === "string" ? metadata.source : "";
	const tags = Array.isArray(metadata.tags)
		? metadata.tags.filter((tag): tag is string => typeof tag === "string")
		: [];
	const text =
		typeof memory.content?.text === "string" ? memory.content.text : "";
	return (
		SYNTHETIC_SOURCE_RE.test(source) ||
		tags.some((tag) => SYNTHETIC_SOURCE_RE.test(tag)) ||
		isSyntheticConversationArtifactText(text)
	);
}
