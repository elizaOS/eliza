/** Unit tests for presentDocument: deterministic mapping of document Memory metadata to display cards (no runtime). */
import type { Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  getDocumentTitleFromMetadata,
  presentDocument,
} from "./document-presenter";

function docMemory(metadata: Record<string, unknown>): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000d1" as UUID,
    entityId: "00000000-0000-0000-0000-0000000000e1" as UUID,
    roomId: "00000000-0000-0000-0000-0000000000r1" as UUID,
    agentId: "00000000-0000-0000-0000-0000000000a1" as UUID,
    createdAt: 1000,
    content: { text: "hello from the transcript" },
    metadata: metadata as Memory["metadata"],
  };
}

describe("presentDocument — transcript link passthrough", () => {
  it("surfaces transcriptId + audio URL when the doc mirrors a Transcript", () => {
    const dto = presentDocument(
      docMemory({
        type: "document",
        source: "transcript",
        transcriptId: "00000000-0000-0000-0000-000000000abc",
        audioUrl: "/api/media/abc123.wav",
        filename: "standup.txt",
      }),
      1,
    );
    expect(dto.transcriptId).toBe("00000000-0000-0000-0000-000000000abc");
    expect(dto.transcriptAudioUrl).toBe("/api/media/abc123.wav");
  });

  it("omits the transcript fields for a plain (non-transcript) document", () => {
    const dto = presentDocument(
      docMemory({ type: "document", source: "user", filename: "notes.txt" }),
      1,
    );
    expect(dto.transcriptId).toBeUndefined();
    expect(dto.transcriptAudioUrl).toBeUndefined();
  });
});

describe("presentDocument — import provenance", () => {
  it("labels conversation imports distinctly from manual uploads", () => {
    const dto = presentDocument(
      docMemory({
        type: "document",
        source: "import",
        addedFrom: "import",
        filename: "claude/conv-1.md",
      }),
      1,
    );

    expect(dto.source).toBe("import");
    expect(dto.addedFrom).toBe("import");
    expect(dto.provenance).toEqual({
      kind: "import",
      label: "Conversation import",
    });
  });
});

describe("getDocumentTitleFromMetadata — derived-title truncation", () => {
  it("never splits a surrogate pair at the truncation cut", () => {
    // The 😀 spans code units 78..79 of the first line, exactly where the
    // 80-char label cut lands; a blind slice would leave a lone high surrogate
    // that renders as U+FFFD in the documents view.
    const line = `${"x".repeat(78)}😀${"y".repeat(20)}`;
    const title = getDocumentTitleFromMetadata(undefined, line);
    expect(title.isWellFormed()).toBe(true);
    expect(title).toBe(`${"x".repeat(78)}...`);
  });

  it("keeps an astral char that falls fully inside the kept prefix", () => {
    const line = `😀${"x".repeat(100)}`;
    const title = getDocumentTitleFromMetadata(undefined, line);
    expect(title.isWellFormed()).toBe(true);
    expect(title.startsWith("😀")).toBe(true);
    expect(title.endsWith("...")).toBe(true);
  });
});
