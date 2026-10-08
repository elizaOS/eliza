import { type Memory, MemoryType, type UUID } from "@elizaos/core";
/**
 * Exercises browser-safe immutable document segmentation and bounded exact
 * reconstruction, including corruption and missing-prefix mutants.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildDocumentSourceProjection,
  DOCUMENT_SOURCE_SEGMENT_MAX_BYTES,
  projectDocumentParentContent,
  readDocumentSourceProjection,
  requireDocumentSourceReadMetadata,
} from "./source-segments.ts";

const DOCUMENT_ID = "10000000-0000-4000-8000-000000000001" as UUID;
const AGENT_ID = "10000000-0000-4000-8000-000000000002" as UUID;
const ROOM_ID = "10000000-0000-4000-8000-000000000003" as UUID;

function projection(text: string) {
  const documentMetadata = {
    type: MemoryType.DOCUMENT,
    documentId: DOCUMENT_ID,
    source: "test",
    scope: "global" as const,
    documentRevision: 0,
  };
  const source = buildDocumentSourceProjection({
    text,
    documentId: DOCUMENT_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    entityId: AGENT_ID,
    documentMetadata,
  });
  const parent: Memory = {
    id: DOCUMENT_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    entityId: AGENT_ID,
    content: projectDocumentParentContent({
      text,
      projection: source.metadata,
    }),
    metadata: { ...documentMetadata, ...source.metadata },
  };
  return { parent, segments: source.segments };
}

function read(
  projected: ReturnType<typeof projection>,
  params: { unit: "line" | "fragment" | "byte"; offset: number; limit: number },
  segments = projected.segments,
) {
  return readDocumentSourceProjection({
    segments,
    params,
    parent: requireDocumentSourceReadMetadata(
      projected.parent.metadata as Record<string, unknown>,
      DOCUMENT_ID,
    ),
    documentId: DOCUMENT_ID,
    sourceQueryCount: 2,
  });
}

describe("canonical document source segments", () => {
  it("builds without a Buffer global and externalizes only large parents", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
    vi.stubGlobal("Buffer", undefined);
    try {
      const small = projection("alpha\nβeta\n");
      expect(small.parent.content.text).toBe("alpha\nβeta\n");
      const large = projection(
        "x".repeat(DOCUMENT_SOURCE_SEGMENT_MAX_BYTES + 1),
      );
      expect(large.parent.content.text).toBeUndefined();
      expect(large.parent.content.documentSource).toMatchObject({
        kind: "document-source",
        storage: "segments",
      });
    } finally {
      vi.unstubAllGlobals();
      if (original) Object.defineProperty(globalThis, "Buffer", original);
    }
  });

  it("reconstructs mixed newline and UTF-8 byte pages exactly", () => {
    const text = `alpha\r\nβeta\n${"z".repeat(DOCUMENT_SOURCE_SEGMENT_MAX_BYTES)}\rterminal`;
    const projected = projection(text);
    expect(
      read(projected, { unit: "line", offset: 0, limit: 2 }),
    ).toMatchObject({
      unit: "line",
      text: "alpha\r\nβeta\n",
      start: 0,
      end: 2,
    });
    const parts: string[] = [];
    let offset = 0;
    for (;;) {
      const page = read(projected, { unit: "byte", offset, limit: 32 * 1024 });
      parts.push(page.text);
      if (page.end === page.total) break;
      expect(page.end).toBeGreaterThan(offset);
      offset = page.end;
    }
    expect(parts.join("")).toBe(text);
  });

  it.each([
    ["a line ending", `${"a".repeat(DOCUMENT_SOURCE_SEGMENT_MAX_BYTES)}\n`],
    [
      "the LF of a CRLF",
      `${"a".repeat(DOCUMENT_SOURCE_SEGMENT_MAX_BYTES - 1)}\r\n`,
    ],
    [
      "trailing spaces",
      `${"a".repeat(DOCUMENT_SOURCE_SEGMENT_MAX_BYTES - 1)}   \n`,
    ],
    [
      "part of a blank line",
      `${"a".repeat(DOCUMENT_SOURCE_SEGMENT_MAX_BYTES - 2)}\n  \n`,
    ],
  ])(
    "pages fragments exactly when a segment cut leaves only %s",
    (_cut, head) => {
      const text = `${head}tail\n\nnext\n`;
      const projected = projection(text);
      expect(projected.segments).toHaveLength(2);
      const { total } = read(projected, {
        unit: "fragment",
        offset: 0,
        limit: 1,
      });
      const pages = Array.from(
        { length: total },
        (_, offset) =>
          read(projected, { unit: "fragment", offset, limit: 1 }).text,
      );
      expect(pages.at(-1)).toBe("next\n");
      expect(pages.join("")).toBe(text);
    },
  );

  it("starts an oversized fragment page after a cut line's whitespace tail", () => {
    const head = `${"a".repeat(DOCUMENT_SOURCE_SEGMENT_MAX_BYTES)}\ntail\n\n`;
    const projected = projection(
      `${head}${"b".repeat(5 * DOCUMENT_SOURCE_SEGMENT_MAX_BYTES)}\n`,
    );
    // The adapter returns at most five rows covering fragment 1.
    const page = read(
      projected,
      { unit: "fragment", offset: 1, limit: 1 },
      projected.segments.slice(1, 6),
    );
    expect([page.unit, page.start]).toEqual(["byte", head.length]);
    expect(page.text).toBe("b".repeat(3 * DOCUMENT_SOURCE_SEGMENT_MAX_BYTES));
  });

  it.each(["line", "fragment"] as const)(
    "rejects a %s page whose first covering segment is missing",
    (unit) => {
      const projected = projection(
        Array.from({ length: 12_000 }, (_, index) => `record-${index}\n`).join(
          "",
        ),
      );
      expect(projected.segments.length).toBeGreaterThan(1);
      expect(() =>
        read(
          projected,
          { unit, offset: 0, limit: 10_000 },
          projected.segments.slice(1, 2),
        ),
      ).toThrowError(
        expect.objectContaining({ code: "DOCUMENT_SOURCE_CORRUPT" }),
      );
    },
  );

  it("rejects coordinate and same-length payload mutations", () => {
    const projected = projection("safe\n".repeat(20_000));
    const mutated = projected.segments.map((segment) => ({
      ...segment,
      content: { ...segment.content },
      metadata: { ...segment.metadata },
    }));
    mutated[0].content.text = `q${mutated[0].content.text?.slice(1)}`;
    expect(() =>
      read(projected, { unit: "byte", offset: 0, limit: 10 }, mutated),
    ).toThrowError(
      expect.objectContaining({ code: "DOCUMENT_SOURCE_CORRUPT" }),
    );
  });

  it("rejects safe-integer overflow before selecting a source range", () => {
    const projected = projection("bounded\n");
    expect(() =>
      read(projected, {
        unit: "byte",
        offset: Number.MAX_SAFE_INTEGER,
        limit: 2,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "DOCUMENT_READ_INVALID_RANGE" }),
    );
  });
});
