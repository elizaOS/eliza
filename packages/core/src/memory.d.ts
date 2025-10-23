import { type Memory, type MemoryMetadata, type MessageMemory, type DocumentMetadata, type FragmentMetadata, type MessageMetadata, type DescriptionMetadata, type CustomMetadata, type Content, type UUID } from './types';
/**
 * Factory function to create a new message memory with proper defaults
 */
export declare function createMessageMemory(params: {
    id?: UUID;
    entityId: UUID;
    agentId?: UUID;
    roomId: UUID;
    content: Content & {
        text: string;
    };
    embedding?: number[];
}): MessageMemory;
/**
 * Type guard to check if a memory metadata is a DocumentMetadata
 * @param metadata The metadata to check
 * @returns True if the metadata is a DocumentMetadata
 */
export declare function isDocumentMetadata(metadata: MemoryMetadata): metadata is DocumentMetadata;
/**
 * Type guard to check if a memory metadata is a FragmentMetadata
 * @param metadata The metadata to check
 * @returns True if the metadata is a FragmentMetadata
 */
export declare function isFragmentMetadata(metadata: MemoryMetadata): metadata is FragmentMetadata;
/**
 * Type guard to check if a memory metadata is a MessageMetadata
 * @param metadata The metadata to check
 * @returns True if the metadata is a MessageMetadata
 */
export declare function isMessageMetadata(metadata: MemoryMetadata): metadata is MessageMetadata;
/**
 * Type guard to check if a memory metadata is a DescriptionMetadata
 * @param metadata The metadata to check
 * @returns True if the metadata is a DescriptionMetadata
 */
export declare function isDescriptionMetadata(metadata: MemoryMetadata): metadata is DescriptionMetadata;
/**
 * Type guard to check if a memory metadata is a CustomMetadata
 * @param metadata The metadata to check
 * @returns True if the metadata is a CustomMetadata
 */
export declare function isCustomMetadata(metadata: MemoryMetadata): metadata is CustomMetadata;
/**
 * Memory type guard for document memories
 */
export declare function isDocumentMemory(memory: Memory): memory is Memory & {
    metadata: DocumentMetadata;
};
/**
 * Memory type guard for fragment memories
 */
export declare function isFragmentMemory(memory: Memory): memory is Memory & {
    metadata: FragmentMetadata;
};
/**
 * Safely access the text content of a memory
 * @param memory The memory to extract text from
 * @param defaultValue Optional default value if no text is found
 * @returns The text content or default value
 */
export declare function getMemoryText(memory: Memory, defaultValue?: string): string;
//# sourceMappingURL=memory.d.ts.map