/**
 * Factory and type guards for {@link Memory} records: `createMessageMemory`
 * stamps a MESSAGE-metadata memory (scope from the explicit `scope` param,
 * else a fail-closed default), and the `is*Metadata` / `is*Memory` guards
 * discriminate a record's kind by its `MemoryType` tag so storage, embedding,
 * and retrieval can branch on it. `isCustomMetadata` is the catch-all for any type outside the four known
 * kinds. The types come from `./types` (`types/memory.ts`); this module holds
 * only the runtime helpers over them.
 */

import {
	type Content,
	type CustomMetadata,
	type DescriptionMetadata,
	type DocumentMetadata,
	type FragmentMetadata,
	type Memory,
	type MemoryMetadata,
	type MemoryScope,
	MemoryType,
	type MessageMemory,
	type MessageMetadata,
	type UUID,
} from "./types";

/**
 * Build a MESSAGE-metadata memory. Scope is FAIL-CLOSED by default: an
 * unspecified scope stamps `private` when an `agentId` is present (unchanged
 * historical behavior) and `owner-private` otherwise. It used to default to
 * `shared` — readable by every actor on the scope ladder — which meant any
 * writer that forgot to think about scope (e.g. the `/api/memory/remember`
 * hash-memory route) published its rows to strangers. A caller that truly
 * wants a world-readable memory must now say so explicitly via `scope`.
 */
export function createMessageMemory(params: {
	id?: UUID;
	entityId: UUID;
	agentId?: UUID;
	roomId: UUID;
	content: Content & { text: string };
	embedding?: number[];
	scope?: MemoryScope;
}): MessageMemory {
	const { scope, ...memoryFields } = params;
	const now = Date.now();
	return {
		...memoryFields,
		createdAt: now,
		metadata: {
			type: MemoryType.MESSAGE,
			timestamp: now,
			scope: scope ?? (params.agentId ? "private" : "owner-private"),
		},
	};
}

export function isDocumentMetadata(
	metadata: MemoryMetadata,
): metadata is DocumentMetadata {
	return metadata.type === MemoryType.DOCUMENT;
}

/**
 * Type guard to check if a memory metadata is a FragmentMetadata
 * @param metadata The metadata to check
 * @returns True if the metadata is a FragmentMetadata
 */
export function isFragmentMetadata(
	metadata: MemoryMetadata,
): metadata is FragmentMetadata {
	return metadata.type === MemoryType.FRAGMENT;
}

export function isMessageMetadata(
	metadata: MemoryMetadata,
): metadata is MessageMetadata {
	return metadata.type === MemoryType.MESSAGE;
}

/**
 * Type guard to check if a memory metadata is a DescriptionMetadata
 * @param metadata The metadata to check
 * @returns True if the metadata is a DescriptionMetadata
 */
export function isDescriptionMetadata(
	metadata: MemoryMetadata,
): metadata is DescriptionMetadata {
	return metadata.type === MemoryType.DESCRIPTION;
}

export function isCustomMetadata(
	metadata: MemoryMetadata,
): metadata is CustomMetadata {
	return (
		metadata.type !== MemoryType.DOCUMENT &&
		metadata.type !== MemoryType.FRAGMENT &&
		metadata.type !== MemoryType.MESSAGE &&
		metadata.type !== MemoryType.DESCRIPTION
	);
}

/**
 * Memory type guard for document memories
 */
export function isDocumentMemory(
	memory: Memory,
): memory is Memory & { metadata: DocumentMetadata } {
	return (
		memory.metadata !== undefined &&
		memory.metadata.type === MemoryType.DOCUMENT
	);
}

/**
 * Memory type guard for fragment memories
 */
export function isFragmentMemory(
	memory: Memory,
): memory is Memory & { metadata: FragmentMetadata } {
	return (
		memory.metadata !== undefined &&
		memory.metadata.type === MemoryType.FRAGMENT
	);
}

export function getMemoryText(memory: Memory, defaultValue = ""): string {
	return memory.content.text ?? defaultValue;
}
