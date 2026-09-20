/**
 * Factory and type guards for {@link Memory} records: `createMessageMemory`
 * stamps a MESSAGE-metadata memory (scope from the explicit `scope` param,
 * else derived from whether an `agentId` is present), and the `is*Metadata` /
 * `is*Memory` guards discriminate a record's kind by its `MemoryType` tag so
 * storage, embedding, and retrieval can branch on it. `isCustomMetadata` is
 * the catch-all for any type outside the four known
 * kinds. The types come from `./types` (`types/memory.ts`); this module holds
 * only the runtime helpers over them.
 */

import { ElizaError } from "./errors";

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
 * Build a MESSAGE-metadata memory. When `scope` is omitted the historical
 * defaults apply: `private` with an `agentId`, `shared` without one. Those
 * defaults are intentional — omit-`agentId` callers (inbound chat, cloud
 * events, CLI chat) rely on `shared` so a non-owner's own message stays
 * readable to them and to the agent. Writers that need a tighter tier (e.g.
 * the `/api/memory/remember` hash-memory route, which stamps `agent-private`)
 * pass `scope` explicitly instead of the factory guessing for them.
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
			scope: scope ?? (params.agentId ? "private" : "shared"),
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

/** Stamp app-owned records at their trusted persistence boundary. Existing
 * identity and scope fields remain authoritative; conflicting origins are not
 * rewritten. Callers must establish app ownership before invoking this helper. */
export function stampAppConversationProvenance<T extends Memory>(
	agentId: UUID,
	memory: T,
): T {
	if (!memory.id) {
		throw new ElizaError("Conversation memory is missing its durable id", {
			code: "CONVERSATION_MEMORY_ID_MISSING",
			context: { roomId: memory.roomId },
		});
	}
	const metadataRecord =
		memory.metadata &&
		typeof memory.metadata === "object" &&
		!Array.isArray(memory.metadata)
			? (memory.metadata as Record<string, unknown>)
			: {};
	const readMetadataString = (key: string): string | undefined => {
		const value = metadataRecord[key];
		return typeof value === "string" && value.trim() ? value : undefined;
	};
	const provider = readMetadataString("provider") ?? "client_chat";
	const accountId = readMetadataString("accountId") ?? agentId;
	const platformMessageId =
		readMetadataString("platformMessageId") ?? memory.id;
	// SQL fills an omitted agent ID with the current runtime's ID. Stamp the
	// same identity before exact-retry comparison, keeping the factory's
	// existing metadata.scope (which may intentionally be shared).
	memory.agentId ??= agentId;
	memory.metadata = {
		...metadataRecord,
		type: "message",
		scope: memory.metadata?.scope ?? "private",
		provider,
		accountId,
		platformMessageId,
		sourceId: readMetadataString("sourceId") ?? platformMessageId,
	} satisfies MessageMetadata;
	return memory;
}
