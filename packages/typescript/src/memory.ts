import {
  type Content,
  type CustomMetadata,
  type DescriptionMetadata,
  type DocumentMetadata,
  type FragmentMetadata,
  type Memory,
  type MemoryMetadata,
  MemoryType,
  type MessageMemory,
  type MessageMetadata,
  type UUID,
} from "./types";

export function createMessageMemory(params: {
  id?: UUID;
  entityId: UUID;
  agentId?: UUID;
  roomId: UUID;
  content: Content & { text: string };
  embedding?: number[];
}): MessageMemory {
  const now = Date.now();
  return {
    ...params,
    createdAt: now,
    metadata: {
      type: MemoryType.MESSAGE,
      timestamp: now,
      scope: params.agentId ? "private" : "shared",
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
