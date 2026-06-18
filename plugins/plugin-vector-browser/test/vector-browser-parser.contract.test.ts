/**
 * External-API contract test for the Vector Browser parser.
 *
 * The Vector Browser view does not call a public third-party API — its
 * dataSource is the elizaOS agent's own `/api/database/query` endpoint, which
 * returns rows shaped by the `memories` table JOINed with the `embeddings`
 * table from @elizaos/plugin-sql. This test runs the REAL parser exported from
 * @elizaos/ui (`rowToMemory`, `parseEmbedding`, `parseContent`, `hasEmbedding`,
 * `buildVectorGraph2DLayout`, `projectTo2D`, `projectTo3D`) over fixtures whose
 * shape is verified against that schema:
 *
 *   - embeddings table columns dim_384..dim_3072 are pgvector columns; the view
 *     casts them `::text`, so the driver returns strings like "[0.01,0.02,...]".
 *     Source: plugins/plugin-sql/src/schema/embedding.ts (VECTOR_DIMS /
 *     DIMENSION_MAP -> "dim_384".."dim_3072") and the JOIN SELECT in
 *     plugins/plugin-vector-browser/src/VectorBrowserView.tsx (buildJoinQuery /
 *     loadGraphData both emit `e."dim_NNN"::text AS "dim_NNN"`).
 *   - memories.content is JSON text like {"text":"..."}; snake_case metadata
 *     columns (room_id / entity_id / created_at) and a boolean `unique`.
 *     Source: plugins/plugin-sql/src/schema/memory.ts.
 *
 * QueryResult shape (columns/rows/rowCount/durationMs) is asserted to match the
 * canonical contract in packages/shared/src/api/agent-api-types.ts.
 */

import type { QueryResult } from "@elizaos/ui/api";
import {
  buildVectorGraph2DLayout,
  DIM_COLUMNS,
  hasEmbedding,
  parseContent,
  parseEmbedding,
  projectTo2D,
  projectTo3D,
  rowToMemory,
} from "@elizaos/ui/components/pages/vector-browser-utils";
import { describe, expect, it } from "vitest";

/** Build a pgvector ::text string of the requested dimension. */
function pgvectorText(dim: number, seed: number): string {
  const parts: number[] = [];
  for (let i = 0; i < dim; i += 1) {
    // deterministic, distinct per-row so PCA has real variance
    parts.push(Number(((seed + 1) * 0.013 + i * 0.0007).toFixed(6)));
  }
  return `[${parts.join(",")}]`;
}

/**
 * One row exactly as the agent's /api/database/query returns it for the
 * memories+embeddings JOIN (after the ::text cast on the dim column).
 */
function joinRow(opts: {
  id: string;
  text: string;
  type: string;
  roomId: string;
  entityId: string;
  unique: boolean;
  dimColumn: (typeof DIM_COLUMNS)[number];
  dim: number;
  seed: number;
}): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: opts.id,
    content: JSON.stringify({ text: opts.text }),
    type: opts.type,
    room_id: opts.roomId,
    entity_id: opts.entityId,
    created_at: "2026-06-16T10:30:00.000Z",
    unique: opts.unique,
  };
  // Only the matching dim column is populated; the rest come back NULL.
  for (const col of DIM_COLUMNS) {
    row[col] =
      col === opts.dimColumn ? pgvectorText(opts.dim, opts.seed) : null;
  }
  return row;
}

describe("parseEmbedding (real elizaOS pgvector shapes)", () => {
  it("parses a pgvector ::text string to a number[] of the right length", () => {
    const text = pgvectorText(768, 3);
    const parsed = parseEmbedding(text);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(768);
    // first value matches the deterministic generator: (3+1)*0.013 + 0 = 0.052
    expect(parsed?.[0]).toBeCloseTo(0.052, 6);
  });

  it("parses a bare comma-separated string (no brackets)", () => {
    expect(parseEmbedding("0.1,0.2,0.3")).toEqual([0.1, 0.2, 0.3]);
  });

  it("parses a JSON array as-is", () => {
    expect(parseEmbedding([0.5, 0.25, 0.125])).toEqual([0.5, 0.25, 0.125]);
  });

  it("parses a Float32Array typed-array embedding", () => {
    const ta = new Float32Array([1, 2, 3]);
    const parsed = parseEmbedding(ta);
    expect(parsed).toHaveLength(3);
    expect(parsed?.[0]).toBeCloseTo(1, 5);
    expect(parsed?.[2]).toBeCloseTo(3, 5);
  });

  it("returns null for empty / scalar / single-value / non-vector inputs", () => {
    expect(parseEmbedding(null)).toBeNull();
    expect(parseEmbedding(undefined)).toBeNull();
    expect(parseEmbedding("")).toBeNull();
    expect(parseEmbedding("[]")).toBeNull();
    // single scalar (the smoke fixture's dim_0=0.1 shape) is NOT a vector
    expect(parseEmbedding("0.1")).toBeNull();
    expect(parseEmbedding("[0.1]")).toBeNull();
    expect(parseEmbedding(0.42)).toBeNull();
    // a malformed token poisons the whole parse
    expect(parseEmbedding("[0.1,foo,0.3]")).toBeNull();
  });
});

describe("parseContent (memories.content JSON unwrapping)", () => {
  it("unwraps {text} JSON string content", () => {
    expect(parseContent('{"text":"hello world"}')).toBe("hello world");
  });

  it("unwraps {content} JSON string content", () => {
    expect(parseContent('{"content":"nested body"}')).toBe("nested body");
  });

  it("unwraps a plain object {text}", () => {
    expect(parseContent({ text: "from object" })).toBe("from object");
  });

  it("returns a plain string verbatim", () => {
    expect(parseContent("just a string")).toBe("just a string");
  });

  it("returns the original JSON string when it has neither text nor content", () => {
    expect(parseContent('{"foo":1}')).toBe('{"foo":1}');
  });
});

describe("rowToMemory (memories+embeddings JOIN row mapping)", () => {
  it("maps a real JOIN row: snake_case columns, dim_* embedding, unwrapped content", () => {
    const row = joinRow({
      id: "mem-1",
      text: "the agent remembered the user prefers tea",
      type: "fact",
      roomId: "room-abc",
      entityId: "entity-xyz",
      unique: true,
      dimColumn: "dim_768",
      dim: 768,
      seed: 1,
    });

    const mem = rowToMemory(row);

    expect(mem.id).toBe("mem-1");
    expect(mem.content).toBe("the agent remembered the user prefers tea");
    expect(mem.type).toBe("fact");
    expect(mem.roomId).toBe("room-abc");
    expect(mem.entityId).toBe("entity-xyz");
    expect(mem.createdAt).toBe("2026-06-16T10:30:00.000Z");
    expect(mem.unique).toBe(true);
    // embedding is pulled from the dim_768 column via DIM_COLUMNS
    expect(mem.embedding).not.toBeNull();
    expect(mem.embedding).toHaveLength(768);
    // raw preserves the untouched driver row
    expect(mem.raw).toBe(row);
  });

  it("picks the embedding from whichever dim_* column is populated", () => {
    for (const [col, dim] of [
      ["dim_384", 384],
      ["dim_1536", 1536],
    ] as const) {
      const row = joinRow({
        id: `mem-${col}`,
        text: "x",
        type: "message",
        roomId: "r",
        entityId: "e",
        unique: false,
        dimColumn: col,
        dim,
        seed: 2,
      });
      const mem = rowToMemory(row);
      expect(mem.embedding).toHaveLength(dim);
    }
  });

  it("falls back to memory_id when there is no id column, and unique=1", () => {
    const mem = rowToMemory({
      memory_id: "fallback-id",
      content: "plain text body",
      type: "message",
      room_id: "r1",
      entity_id: "e1",
      created_at: "2026-01-01T00:00:00.000Z",
      unique: 1,
      dim_768: null,
    });
    expect(mem.id).toBe("fallback-id");
    expect(mem.unique).toBe(true);
    expect(mem.embedding).toBeNull();
    expect(hasEmbedding(mem)).toBe(false);
  });

  it("yields embedding=null when every dim_* column is null (no-embedding row)", () => {
    const row = joinRow({
      id: "mem-empty",
      text: "no vector here",
      type: "message",
      roomId: "r",
      entityId: "e",
      unique: false,
      dimColumn: "dim_768",
      dim: 768,
      seed: 0,
    });
    for (const col of DIM_COLUMNS) row[col] = null;
    const mem = rowToMemory(row);
    expect(mem.embedding).toBeNull();
    expect(hasEmbedding(mem)).toBe(false);
  });
});

describe("buildVectorGraph2DLayout + PCA projection", () => {
  function makeMemories(count: number, withEmbedding: boolean, dim = 768) {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i += 1) {
      const row = joinRow({
        id: `m-${i}`,
        text: `memory ${i}`,
        type: i % 2 === 0 ? "fact" : "message",
        roomId: "r",
        entityId: "e",
        unique: false,
        dimColumn: "dim_768",
        dim,
        seed: i,
      });
      if (!withEmbedding) {
        for (const col of DIM_COLUMNS) row[col] = null;
      }
      rows.push(row);
    }
    return rows.map(rowToMemory);
  }

  it("returns null with fewer than 2 embedded memories", () => {
    expect(buildVectorGraph2DLayout([])).toBeNull();
    expect(buildVectorGraph2DLayout(makeMemories(1, true))).toBeNull();
    expect(buildVectorGraph2DLayout(makeMemories(5, false))).toBeNull();
  });

  it("returns a layout with one point per embedded memory and per-type colors", () => {
    const memories = makeMemories(4, true);
    const layout = buildVectorGraph2DLayout(memories);
    expect(layout).not.toBeNull();
    if (!layout) return;

    expect(layout.points).toHaveLength(4);
    expect(layout.withEmbeddings).toHaveLength(4);
    // two distinct types (fact / message) => two color entries
    expect(Object.keys(layout.typeColors).sort()).toEqual(["fact", "message"]);
    // every projected point is a 2-tuple of finite numbers
    for (const [x, y] of layout.points) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
    // bounds are derived (rangeX/rangeY never zero)
    expect(layout.bounds.rangeX).toBeGreaterThan(0);
    expect(layout.bounds.rangeY).toBeGreaterThan(0);
  });

  it("filters non-embedded memories out of the layout", () => {
    const mixed = [...makeMemories(3, true), ...makeMemories(2, false)];
    const layout = buildVectorGraph2DLayout(mixed);
    expect(layout?.withEmbeddings).toHaveLength(3);
    expect(layout?.points).toHaveLength(3);
  });

  it("projectTo2D / projectTo3D return N tuples of arity 2 / 3", () => {
    const memories = makeMemories(5, true);
    const vecs = memories
      .filter(hasEmbedding)
      .map((m) => m.embedding as number[]);
    const p2 = projectTo2D(vecs);
    const p3 = projectTo3D(vecs);
    expect(p2).toHaveLength(5);
    expect(p3).toHaveLength(5);
    expect(p2[0]).toHaveLength(2);
    expect(p3[0]).toHaveLength(3);
  });
});

describe("QueryResult contract shape", () => {
  it("matches the canonical agent-api-types QueryResult", () => {
    // The view reads result.rows (Array) and countRows[0]?.cnt. A real
    // QueryResult carries columns/rows/rowCount/durationMs.
    const result: QueryResult = {
      columns: ["id", "content", "dim_768"],
      rows: [
        joinRow({
          id: "m-0",
          text: "shape check",
          type: "fact",
          roomId: "r",
          entityId: "e",
          unique: true,
          dimColumn: "dim_768",
          dim: 768,
          seed: 0,
        }),
      ],
      rowCount: 1,
      durationMs: 4,
    };
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.rowCount).toBe(1);
    const mem = rowToMemory(result.rows[0]);
    expect(mem.content).toBe("shape check");
    expect(mem.embedding).toHaveLength(768);
  });
});
