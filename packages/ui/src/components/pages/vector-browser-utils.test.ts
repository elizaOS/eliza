/**
 * Unit tests for vector-browser-utils: validates embedding parsing, memory mapping, screen projection, and PCA layout.
 */
import { describe, expect, it } from "vitest";
import {
  buildVectorGraph2DLayout,
  parseContent,
  parseEmbedding,
  projectTo2D,
  projectTo3D,
  rowToMemory,
  toVectorGraph2DScreenX,
  toVectorGraph2DScreenY,
} from "./vector-browser-utils.ts";

describe("vector-browser-utils", () => {
  it("parses text and JSON content with fallback fields", () => {
    expect(parseContent("simple text")).toBe("simple text");
    expect(parseContent('{"text": "extracted message"}')).toBe(
      "extracted message",
    );
    expect(parseContent('{"content": "fallback body"}')).toBe("fallback body");
    expect(parseContent({ text: "from object" })).toBe("from object");
    expect(parseContent(12345)).toBe("12345");
  });

  it("parses embeddings from pgvector brackets, comma-separated strings, and float arrays", () => {
    expect(parseEmbedding("[0.1, 0.2, 0.3]")).toEqual([0.1, 0.2, 0.3]);
    expect(parseEmbedding("0.5, -0.25, 1.75")).toEqual([0.5, -0.25, 1.75]);
    expect(parseEmbedding([1, 2, 3])).toEqual([1, 2, 3]);
    expect(parseEmbedding(new Float64Array([0.1, 0.2]))).toEqual([0.1, 0.2]);
    expect(parseEmbedding("invalid,nan,test")).toBeNull();
    expect(parseEmbedding("single")).toBeNull();
    expect(parseEmbedding(null)).toBeNull();
  });

  it("normalizes database row into MemoryRecord with dim column detection", () => {
    const row = {
      id: "mem-1",
      body: "note content",
      roomId: "room-123",
      dim_384: [0.1, 0.2, 0.3],
      unique: 1,
    };
    const memory = rowToMemory(row);
    expect(memory.id).toBe("mem-1");
    expect(memory.content).toBe("note content");
    expect(memory.roomId).toBe("room-123");
    expect(memory.unique).toBe(true);
    expect(memory.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("projects vector points to 2D screen coordinates with padding and bounds", () => {
    const bounds = { minX: 0, minY: 0, rangeX: 100, rangeY: 50 };
    expect(toVectorGraph2DScreenX(50, 500, 20, bounds)).toBe(
      20 + 0.5 * (500 - 40),
    );
    expect(toVectorGraph2DScreenY(25, 300, 10, bounds)).toBe(
      10 + 0.5 * (300 - 20),
    );
  });

  it("computes PCA 2D/3D projections and builds 2D graph layout", () => {
    const vectors = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];
    const p2d = projectTo2D(vectors);
    expect(p2d.length).toBe(4);
    expect(p2d[0].length).toBe(2);

    const p3d = projectTo3D(vectors);
    expect(p3d.length).toBe(4);
    expect(p3d[0].length).toBe(3);

    const memories = vectors.map((v, i) => ({
      id: `m-${i}`,
      content: `text ${i}`,
      roomId: "r1",
      entityId: "e1",
      type: i % 2 === 0 ? "note" : "chat",
      createdAt: "2026-01-01",
      unique: false,
      embedding: v,
      raw: {},
    }));

    const layout = buildVectorGraph2DLayout(memories);
    expect(layout).not.toBeNull();
    expect(layout?.points.length).toBe(4);
    expect(layout?.typeColors.note).toBeDefined();
  });
});
