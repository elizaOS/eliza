/** presentDocument — file size / created-at metadata must be canonical decimals. */

import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { presentDocument } from "../src/document-presenter.ts";

function memory(metadata: Record<string, unknown>, createdAt: unknown): Memory {
  return {
    id: "doc-1",
    entityId: "e1",
    agentId: "a1",
    roomId: "r1",
    content: { text: "hello" },
    createdAt,
    metadata,
  } as Memory;
}

describe("presentDocument numeric metadata", () => {
  it("accepts canonical decimal spellings", () => {
    const doc = presentDocument(
      memory(
        { fileSize: " 12345 ", contentType: "text/plain" },
        1_700_000_000_000,
      ),
      1,
    );
    expect(doc.fileSize).toBe(12345);
    expect(doc.createdAt).toBe(1_700_000_000_000);
  });

  it("falls back to 0 for hex, exponent, and empty spellings", () => {
    const doc = presentDocument(
      memory({ fileSize: "0x10", contentType: "text/plain" }, ""),
      1,
    );
    expect(doc.fileSize).toBe(0);
    expect(doc.createdAt).toBe(0);
  });

  it("falls back to 0 for exponent file size", () => {
    const doc = presentDocument(
      memory({ fileSize: "1e5", contentType: "text/plain" }, 1_700_000_000_000),
      1,
    );
    expect(doc.fileSize).toBe(0);
  });
});
