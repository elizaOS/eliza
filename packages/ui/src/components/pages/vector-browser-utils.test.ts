/**
 * Covers the vector-browser derivations: content parsing, embedding parsing
 * across storage formats, database-row normalization, and the 2D graph layout.
 *
 * `parseEmbedding` and `rowToMemory` read straight off database rows, so the
 * contracts that matter are the tolerant ones — pgvector text, JSON arrays, and
 * typed arrays must all resolve, column aliases must all be honoured, and
 * anything unparseable must become an explicit `null` rather than a partially
 * filled vector that would silently distort the projection.
 *
 * Pure functions — no React, no database, no canvas.
 */
import { describe, expect, it } from "vitest";

import {
  buildVectorGraph2DLayout,
  DIM_COLUMNS,
  hasEmbedding,
  type MemoryRecord,
  parseContent,
  parseEmbedding,
  projectTo2D,
  projectTo3D,
  rowToMemory,
  toVectorGraph2DScreenX,
  toVectorGraph2DScreenY,
  VECTOR_GRAPH_2D_PALETTE,
} from "./vector-browser-utils.ts";

const memory = (embedding: number[] | null, type = "message"): MemoryRecord =>
  ({
    id: "m",
    content: "c",
    roomId: "r",
    entityId: "e",
    type,
    createdAt: "",
    unique: false,
    embedding,
    raw: {},
  }) as MemoryRecord;

describe("parseContent", () => {
  it("returns a plain string unchanged", () => {
    expect(parseContent("hello")).toBe("hello");
  });

  it("extracts text or content from a JSON string", () => {
    expect(parseContent('{"text":"hi"}')).toBe("hi");
    expect(parseContent('{"content":"body"}')).toBe("body");
  });

  it("returns the raw string when the JSON is malformed", () => {
    expect(parseContent('{"text":')).toBe('{"text":');
  });

  it("returns the raw string when the JSON has neither field", () => {
    expect(parseContent('{"other":1}')).toBe('{"other":1}');
  });

  it("extracts text or content from an object", () => {
    expect(parseContent({ text: "hi" })).toBe("hi");
    expect(parseContent({ content: "body" })).toBe("body");
  });

  it("pretty-prints an object with neither field", () => {
    expect(parseContent({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it("renders null and undefined as an empty string", () => {
    expect(parseContent(null)).toBe("");
    expect(parseContent(undefined)).toBe("");
  });

  it("stringifies a non-string primitive", () => {
    expect(parseContent(42)).toBe("42");
  });
});

describe("parseEmbedding", () => {
  it("passes an array through", () => {
    expect(parseEmbedding([0.1, 0.2])).toEqual([0.1, 0.2]);
  });

  it("converts a typed array", () => {
    expect(parseEmbedding(new Float32Array([1, 2]))).toEqual([1, 2]);
    expect(parseEmbedding(new Float64Array([1.5, 2.5]))).toEqual([1.5, 2.5]);
  });

  it("parses pgvector bracket text", () => {
    expect(parseEmbedding("[0.1,0.2,0.3]")).toEqual([0.1, 0.2, 0.3]);
  });

  it("parses bare comma-separated text", () => {
    expect(parseEmbedding("0.1,0.2")).toEqual([0.1, 0.2]);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseEmbedding("  [1,2]  ")).toEqual([1, 2]);
  });

  it("returns null rather than a partial vector when a component is unparseable", () => {
    // A half-parsed embedding would silently distort every projection.
    expect(parseEmbedding("[0.1,oops,0.3]")).toBeNull();
  });

  it("returns null for falsy, non-vector, and too-short input", () => {
    for (const value of [null, undefined, 0, "", "[]", "[1]", 42, {}]) {
      expect(parseEmbedding(value)).toBeNull();
    }
  });
});

describe("rowToMemory", () => {
  it("honours every documented id, room, and entity alias", () => {
    expect(rowToMemory({ ID: "x" }).id).toBe("x");
    expect(rowToMemory({ memory_id: "y" }).id).toBe("y");
    expect(rowToMemory({ room_id: "r" }).roomId).toBe("r");
    expect(rowToMemory({ roomID: "r2" }).roomId).toBe("r2");
    expect(rowToMemory({ entity_id: "e" }).entityId).toBe("e");
    expect(rowToMemory({ user_id: "u" }).entityId).toBe("u");
  });

  it("defaults missing fields to an empty string rather than 'undefined'", () => {
    const record = rowToMemory({});
    expect(record.id).toBe("");
    expect(record.roomId).toBe("");
    expect(record.entityId).toBe("");
    expect(record.type).toBe("");
    expect(record.createdAt).toBe("");
  });

  it("coerces the unique flag from each accepted representation", () => {
    expect(rowToMemory({ unique: true }).unique).toBe(true);
    expect(rowToMemory({ unique: 1 }).unique).toBe(true);
    expect(rowToMemory({ isUnique: true }).unique).toBe(true);
    expect(rowToMemory({ unique: 0 }).unique).toBe(false);
    expect(rowToMemory({}).unique).toBe(false);
  });

  it("falls back to an elizaOS dim_* column when no explicit embedding exists", () => {
    for (const dim of DIM_COLUMNS) {
      expect(rowToMemory({ [dim]: "[1,2]" }).embedding).toEqual([1, 2]);
    }
  });

  it("prefers an explicit embedding column over a dim_* column", () => {
    expect(
      rowToMemory({ embedding: "[9,9]", dim_384: "[1,1]" }).embedding,
    ).toEqual([9, 9]);
  });

  it("preserves the original row", () => {
    const row = { id: "a", extra: true };
    expect(rowToMemory(row).raw).toBe(row);
  });
});

describe("hasEmbedding", () => {
  it("narrows on a present embedding", () => {
    expect(hasEmbedding(memory([1, 2]))).toBe(true);
    expect(hasEmbedding(memory(null))).toBe(false);
  });
});

describe("buildVectorGraph2DLayout", () => {
  it("returns null when fewer than two memories carry embeddings", () => {
    expect(buildVectorGraph2DLayout([])).toBeNull();
    expect(buildVectorGraph2DLayout([memory([1, 2])])).toBeNull();
    expect(buildVectorGraph2DLayout([memory([1, 2]), memory(null)])).toBeNull();
  });

  it("projects only the memories that carry embeddings", () => {
    const layout = buildVectorGraph2DLayout([
      memory([1, 0]),
      memory(null),
      memory([0, 1]),
      memory([1, 1]),
    ]);
    expect(layout?.withEmbeddings).toHaveLength(3);
    expect(layout?.points).toHaveLength(3);
  });

  it("never reports a zero range, so screen mapping cannot divide by zero", () => {
    const layout = buildVectorGraph2DLayout([
      memory([1, 1]),
      memory([1, 1]),
      memory([1, 1]),
    ]);
    expect(layout?.bounds.rangeX).not.toBe(0);
    expect(layout?.bounds.rangeY).not.toBe(0);
  });

  it("assigns one palette colour per type and cycles the palette", () => {
    const many = Array.from(
      { length: VECTOR_GRAPH_2D_PALETTE.length + 2 },
      (_, i) => memory([i, i + 1], `type-${i}`),
    );
    const layout = buildVectorGraph2DLayout(many);
    const colors = Object.values(layout?.typeColors ?? {});
    expect(Object.keys(layout?.typeColors ?? {})).toHaveLength(many.length);
    for (const color of colors) {
      expect(VECTOR_GRAPH_2D_PALETTE).toContain(color);
    }
    expect(layout?.typeColors["type-0"]).toBe(
      layout?.typeColors[`type-${VECTOR_GRAPH_2D_PALETTE.length}`],
    );
  });
});

describe("screen mapping", () => {
  const bounds = { minX: 0, minY: 0, rangeX: 10, rangeY: 10 };

  it("maps the minimum onto the padding edge", () => {
    expect(toVectorGraph2DScreenX(0, 100, 10, bounds)).toBe(10);
    expect(toVectorGraph2DScreenY(0, 100, 10, bounds)).toBe(10);
  });

  it("maps the maximum onto the far padded edge", () => {
    expect(toVectorGraph2DScreenX(10, 100, 10, bounds)).toBe(90);
    expect(toVectorGraph2DScreenY(10, 100, 10, bounds)).toBe(90);
  });

  it("maps the midpoint to the centre", () => {
    expect(toVectorGraph2DScreenX(5, 100, 10, bounds)).toBe(50);
  });
});

describe("projections", () => {
  const vectors = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 1, 1],
  ];

  it("projects to two dimensions, one point per input", () => {
    const points = projectTo2D(vectors);
    expect(points).toHaveLength(vectors.length);
    for (const point of points) {
      expect(point).toHaveLength(2);
      expect(point.every((value) => Number.isFinite(value))).toBe(true);
    }
  });

  it("projects to three dimensions, one point per input", () => {
    const points = projectTo3D(vectors);
    expect(points).toHaveLength(vectors.length);
    for (const point of points) {
      expect(point).toHaveLength(3);
      expect(point.every((value) => Number.isFinite(value))).toBe(true);
    }
  });

  it("is deterministic across repeated calls", () => {
    // The vector browser re-projects on every render; a random seed made the
    // same memories land somewhere different each time.
    expect(projectTo2D(vectors)).toEqual(projectTo2D(vectors));
    expect(projectTo3D(vectors)).toEqual(projectTo3D(vectors));
  });

  it("does not mirror between runs over identical data", () => {
    // Power iteration converges to +v or -v depending on where it started.
    const [first] = projectTo2D(vectors);
    const [again] = projectTo2D(vectors);
    expect(Math.sign(first[0])).toBe(Math.sign(again[0]));
  });
});
