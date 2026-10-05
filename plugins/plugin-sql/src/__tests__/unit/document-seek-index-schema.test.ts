/**
 * Verifies the generated SQL schema keeps progressive document indexes
 * unit-specific and orders seek coordinates before optional revision fields.
 */

import { describe, expect, it } from "vitest";
import { generateSnapshot } from "../../runtime-migrator/drizzle-adapters/snapshot-generator";
import { memoryTable } from "../../schema/memory";

describe("progressive-content seek index schema", () => {
  it("makes wrong-unit document indexes ineligible for a bounded seek", async () => {
    const snapshot = await generateSnapshot({ memories: memoryTable });
    const indexes = snapshot.tables["public.memories"].indexes;
    const cases = [
      ["idx_document_source_byte_seek", "sourceByteEnd"],
      ["idx_document_source_line_seek", "sourceLineEnd"],
      ["idx_document_source_fragment_seek", "sourceFragmentEnd"],
    ] as const;
    for (const [name, coordinate] of cases) {
      const index = indexes[name];
      expect(index.where).toContain(`"metadata" ? '${coordinate}'`);
      expect(index.columns.map(({ expression }) => expression)).toEqual([
        "agent_id",
        "((metadata->>'documentId'))",
        "((metadata->>'documentRevision')::bigint)",
        `((metadata->>'${coordinate}')::bigint)`,
        "((metadata->>'revisionAttemptId'))",
      ]);
    }
  });

  it("keeps attachment identity before message byte position", async () => {
    const snapshot = await generateSnapshot({ memories: memoryTable });
    const index = snapshot.tables["public.memories"].indexes.idx_message_content_byte_seek;
    expect(index.columns.map(({ expression }) => expression)).toEqual([
      "agent_id",
      "((metadata->>'messageId'))",
      "((metadata->>'sourceKind'))",
      "((metadata->>'attachmentIdHash'))",
      "((metadata->>'sourceRevision'))",
      "((metadata->>'byteEnd')::bigint)",
    ]);
  });
});
