/**
 * Vector Browser - pure functions, constants, and type definitions.
 */
export declare const PAGE_SIZE = 25;
export declare const MAX_THREE_PIXEL_RATIO = 2;
export type ViewMode = "list" | "graph" | "3d";
/** The dimension columns in the elizaOS `embeddings` table. */
export declare const DIM_COLUMNS: readonly [
  "dim_384",
  "dim_512",
  "dim_768",
  "dim_1024",
  "dim_1536",
  "dim_3072",
];
export interface MemoryRecord {
  id: string;
  content: string;
  roomId: string;
  entityId: string;
  type: string;
  createdAt: string;
  unique: boolean;
  embedding: number[] | null;
  raw: Record<string, unknown>;
}
export declare function hasEmbedding(
  memory: MemoryRecord,
): memory is MemoryRecord & {
  embedding: number[];
};
export interface VectorGraph2DBounds {
  minX: number;
  minY: number;
  rangeX: number;
  rangeY: number;
}
export interface VectorGraph2DLayout {
  bounds: VectorGraph2DBounds;
  points: [number, number][];
  typeColors: Record<string, string>;
  withEmbeddings: Array<
    MemoryRecord & {
      embedding: number[];
    }
  >;
}
export declare const VECTOR_GRAPH_2D_PALETTE: string[];
/** Try to parse a JSON content field, returning the text content or the raw string. */
export declare function parseContent(val: unknown): string;
/** Parse an embedding from various storage formats (pgvector text, JSON, typed arrays). */
export declare function parseEmbedding(val: unknown): number[] | null;
export declare function rowToMemory(row: Record<string, unknown>): MemoryRecord;
export declare function buildVectorGraph2DLayout(
  memories: MemoryRecord[],
): VectorGraph2DLayout | null;
export declare function toVectorGraph2DScreenX(
  x: number,
  width: number,
  padding: number,
  bounds: VectorGraph2DBounds,
): number;
export declare function toVectorGraph2DScreenY(
  y: number,
  height: number,
  padding: number,
  bounds: VectorGraph2DBounds,
): number;
/** Project high-dimensional vectors to 2D using the first two principal axes. */
export declare function projectTo2D(vectors: number[][]): [number, number][];
/** Project high-dimensional vectors to 3D using the first three principal axes. */
export declare function projectTo3D(
  vectors: number[][],
): [number, number, number][];
//# sourceMappingURL=vector-browser-utils.d.ts.map
