/* eslint-disable @typescript-eslint/no-explicit-any */
import { Path } from "neo4j-driver";

export interface GraphRAGConfig {
    vectorDimension?: number;
    maxDepth?: number;
    similarityThreshold?: number;
}

export interface NodeProperties {
    id: string;
    content: string;
    title?: string;
    [key: string]: any;
}

export interface SimilarNode {
    node: NodeProperties;
    score: number;
}

export interface GraphRAGResponse {
    fullContext: string;
    sources: SimilarNode[];
    relatedContext: Path[];
    confidence?: number;
}

export interface EmbeddingResponse {
    embedding: number[];
}

export enum DocumentRelationType {
    REFERENCES = "REFERENCES", // Document A mentions or cites Document B
    CONTINUES = "CONTINUES", // Document A is a continuation of Document B
    SUPERSEDES = "SUPERSEDES", // Document A replaces or updates Document B
    RELATES_TO = "RELATES_TO", // Generic relationship
    DEPENDS_ON = "DEPENDS_ON", // Document A requires Document B
    SIMILAR_TO = "SIMILAR_TO", // Documents are semantically similar
    PART_OF = "PART_OF", // Document A is a component of Document B
    CONTRADICTS = "CONTRADICTS", // Documents have conflicting information
}
