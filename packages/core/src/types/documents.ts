/**
 * Document-ingestion types: a `DocumentItem` (content + metadata + optional
 * embedding similarity) and the source descriptors (path / directory) used when
 * loading documents into memory. Consumed by the documents feature bundle.
 */
import type { MemoryMetadata } from "./memory";
import type { Content, UUID } from "./primitives";

export type DocumentDirectory = {
	path?: string;
	directory?: string;
	shared?: boolean;
};

export type DocumentSourceItem = {
	item:
		| { case: "path"; value: string }
		| { case: "directory"; value: DocumentDirectory }
		| { case: undefined; value?: undefined };
};

export interface DocumentItem {
	id: UUID;
	content: Content;
	metadata?: MemoryMetadata;
	worldId?: UUID;
	similarity?: number;
}

export type DocumentRecord = Partial<DocumentItem>;
