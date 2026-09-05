/**
 * Vector Browser - pure functions, constants, and type definitions.
 */

export const PAGE_SIZE = 25;
export const MAX_THREE_PIXEL_RATIO = 2;

export type ViewMode = "list" | "graph" | "3d";

/** The dimension columns in the elizaOS `embeddings` table. */
export const DIM_COLUMNS = [
  "dim_384",
  "dim_512",
  "dim_768",
  "dim_1024",
  "dim_1536",
  "dim_3072",
] as const;

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

export function hasEmbedding(
  memory: MemoryRecord,
): memory is MemoryRecord & { embedding: number[] } {
  return memory.embedding !== null;
}

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
  withEmbeddings: Array<MemoryRecord & { embedding: number[] }>;
}

export const VECTOR_GRAPH_2D_PALETTE = [
  "#fb923c",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#e11d48",
  "#ec4899",
  "#78716c",
  "#84cc16",
];

/** Try to parse a JSON content field, returning the text content or the raw string. */
export function parseContent(val: unknown): string {
  if (typeof val !== "string") {
    if (val && typeof val === "object") {
      const record = val as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      try {
        return JSON.stringify(val, null, 2);
      } catch {
        return String(val);
      }
    }
    return String(val ?? "");
  }
  if (val.startsWith("{")) {
    try {
      const parsed = JSON.parse(val);
      if (parsed.text) return String(parsed.text);
      if (parsed.content) return String(parsed.content);
      return val;
    } catch {
      return val;
    }
  }
  return val;
}

/** Parse an embedding from various storage formats (pgvector text, JSON, typed arrays). */
export function parseEmbedding(val: unknown): number[] | null {
  if (!val) return null;
  if (Array.isArray(val)) return val as number[];
  // Handle typed arrays (Float32Array, Float64Array, Uint8Array etc.)
  if (ArrayBuffer.isView(val)) {
    return Array.from(val as Float64Array);
  }
  if (typeof val === "string" && val.length > 2) {
    const trimmed = val.trim();
    // pgvector text format: [0.1,0.2,0.3] - also valid JSON
    // Also handle without brackets: 0.1,0.2,0.3
    const inner =
      trimmed.startsWith("[") && trimmed.endsWith("]")
        ? trimmed.slice(1, -1)
        : trimmed;
    if (!inner) return null;
    // Fast path: split by comma and parse floats
    const parts = inner.split(",");
    if (parts.length < 2) return null;
    const nums: number[] = [];
    for (const p of parts) {
      const n = Number.parseFloat(p);
      if (Number.isNaN(n)) return null;
      nums.push(n);
    }
    return nums;
  }
  return null;
}

export function rowToMemory(row: Record<string, unknown>): MemoryRecord {
  // Try explicit embedding/vector column first, then check elizaOS dim_* columns
  let embeddingVal = row.embedding ?? row.vector ?? row.embeddings;
  if (!embeddingVal) {
    for (const dim of DIM_COLUMNS) {
      if (row[dim]) {
        embeddingVal = row[dim];
        break;
      }
    }
  }

  return {
    id: String(row.id ?? row.ID ?? row.memory_id ?? ""),
    content: parseContent(row.content ?? row.body ?? row.text ?? ""),
    roomId: String(row.roomId ?? row.room_id ?? row.roomID ?? ""),
    entityId: String(
      row.entityId ??
        row.entity_id ??
        row.entityID ??
        row.userId ??
        row.user_id ??
        "",
    ),
    type: String(row.type ?? row.memoryType ?? row.memory_type ?? ""),
    createdAt: String(row.createdAt ?? row.created_at ?? row.timestamp ?? ""),
    unique: row.unique === true || row.unique === 1 || row.isUnique === true,
    embedding: parseEmbedding(embeddingVal),
    raw: row,
  };
}

export function buildVectorGraph2DLayout(
  memories: MemoryRecord[],
): VectorGraph2DLayout | null {
  const withEmbeddings = memories.filter(hasEmbedding);
  if (withEmbeddings.length < 2) {
    return null;
  }

  const points = projectTo2D(withEmbeddings.map((memory) => memory.embedding));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const typeColors: Record<string, string> = {};
  const types = [...new Set(withEmbeddings.map((memory) => memory.type))];
  for (let index = 0; index < types.length; index += 1) {
    typeColors[types[index]] =
      VECTOR_GRAPH_2D_PALETTE[index % VECTOR_GRAPH_2D_PALETTE.length];
  }

  return {
    bounds: {
      minX,
      minY,
      rangeX: maxX - minX || 1,
      rangeY: maxY - minY || 1,
    },
    points,
    typeColors,
    withEmbeddings,
  };
}

export function toVectorGraph2DScreenX(
  x: number,
  width: number,
  padding: number,
  bounds: VectorGraph2DBounds,
): number {
  return padding + ((x - bounds.minX) / bounds.rangeX) * (width - 2 * padding);
}

export function toVectorGraph2DScreenY(
  y: number,
  height: number,
  padding: number,
  bounds: VectorGraph2DBounds,
): number {
  return padding + ((y - bounds.minY) / bounds.rangeY) * (height - 2 * padding);
}

// PCA projection utilities.

function dot(a: number[], b: Float64Array | number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * (b[i] ?? 0);
  return s;
}

/**
 * Small deterministic PRNG (mulberry32). Power iteration needs a spread-out
 * starting vector — a uniform one can sit exactly orthogonal to the dominant
 * eigenvector on symmetric input and converge badly — but it must not need an
 * UNPREDICTABLE one.
 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POWER_ITERATION_SEED = 0x5eed;

/**
 * Pin the eigenvector's arbitrary sign. Power iteration converges to either
 * `+v` or `-v` depending on where it started, so without this the whole plot
 * can mirror between two runs over identical data. Canonicalizing on the
 * largest-magnitude component is the usual convention.
 */
function canonicalizeSign(v: Float64Array): void {
  let maxIndex = 0;
  for (let i = 1; i < v.length; i++) {
    if (Math.abs(v[i]) > Math.abs(v[maxIndex])) maxIndex = i;
  }
  if (v[maxIndex] < 0) {
    for (let i = 0; i < v.length; i++) v[i] = -v[i];
  }
}

function powerIteration(
  data: number[][],
  dims: number,
  iters = 30,
): Float64Array {
  const v = new Float64Array(dims);
  // Deterministic init: the vector browser re-projects on every render, and a
  // Math.random() seed made the same memories land somewhere different each
  // time — nodes jumped and the plot could mirror. Seeded by `dims` so the
  // starting vector still varies with the embedding width.
  const random = seededRandom(POWER_ITERATION_SEED + dims);
  for (let d = 0; d < dims; d++) v[d] = random() - 0.5;
  normalize(v);

  for (let iter = 0; iter < iters; iter++) {
    const w = new Float64Array(dims);
    for (const row of data) {
      const d = dot(row, v);
      for (let j = 0; j < dims; j++) w[j] += d * row[j];
    }
    normalize(w);
    for (let d = 0; d < dims; d++) v[d] = w[d];
  }
  canonicalizeSign(v);
  return v;
}

function normalize(v: Float64Array) {
  let len = 0;
  for (let i = 0; i < v.length; i++) len += v[i] * v[i];
  len = Math.sqrt(len) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= len;
}

/** Compute mean and center data for PCA. */
function centerData(vectors: number[][]): {
  centered: number[][];
  mean: Float64Array;
} {
  const dims = vectors[0].length;
  const n = vectors.length;
  const mean = new Float64Array(dims);
  for (const v of vectors) {
    for (let d = 0; d < dims; d++) mean[d] += v[d];
  }
  for (let d = 0; d < dims; d++) mean[d] /= n;
  const centered = vectors.map((v) => v.map((x, d) => x - mean[d]));
  return { centered, mean };
}

/** Deflate data by removing projection onto a principal component. */
function deflate(data: number[][], pc: Float64Array): number[][] {
  const proj = data.map((v) => dot(v, pc));
  return data.map((v, i) => v.map((x, d) => x - proj[i] * pc[d]));
}

/** Project high-dimensional vectors to 2D using the first two principal axes. */
export function projectTo2D(vectors: number[][]): [number, number][] {
  if (vectors.length === 0) return [];
  const dims = vectors[0].length;
  const { centered } = centerData(vectors);

  const pc1 = powerIteration(centered, dims);
  const deflated1 = deflate(centered, pc1);
  const pc2 = powerIteration(deflated1, dims);

  return centered.map((v) => [dot(v, pc1), dot(v, pc2)] as [number, number]);
}

/** Project high-dimensional vectors to 3D using the first three principal axes. */
export function projectTo3D(vectors: number[][]): [number, number, number][] {
  if (vectors.length === 0) return [];
  const dims = vectors[0].length;
  const { centered } = centerData(vectors);

  const pc1 = powerIteration(centered, dims);
  const deflated1 = deflate(centered, pc1);
  const pc2 = powerIteration(deflated1, dims);
  const deflated2 = deflate(deflated1, pc2);
  const pc3 = powerIteration(deflated2, dims);

  return centered.map(
    (v) => [dot(v, pc1), dot(v, pc2), dot(v, pc3)] as [number, number, number],
  );
}
