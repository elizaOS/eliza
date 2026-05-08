import type { Content, UUID } from "./primitives";
import type { MemoryMetadata } from "./proto.js";

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
