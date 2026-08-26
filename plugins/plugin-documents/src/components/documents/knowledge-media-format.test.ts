/**
 * Unit coverage for the Knowledge-hub media-format derivation (#13594): the
 * pure client vocabulary that classifies a record into a display facet and a
 * reader kind from its mime type + transcript signal. Kept mime-only so it runs
 * without the React/jsdom module-resolution setup — this is the "facet
 * derivation from mimeType" coverage the slice-2 review asked for.
 */

import type { DocumentRecord } from "@elizaos/ui/api/client-types-chat";
import { describe, expect, it } from "vitest";
import {
  documentMatchesFacet,
  documentMediaFormat,
  knowledgeFacetCounts,
  knowledgeReaderKind,
} from "./knowledge-media-format";

function doc(partial: Partial<DocumentRecord>): DocumentRecord {
  return {
    id: partial.id ?? "d",
    filename: partial.filename ?? "f",
    contentType: partial.contentType,
    ...partial,
  } as DocumentRecord;
}

describe("documentMediaFormat — facet derivation from mime + transcript", () => {
  it("buckets image/audio/video by mime prefix", () => {
    expect(documentMediaFormat(doc({ contentType: "image/png" }))).toBe(
      "image",
    );
    expect(documentMediaFormat(doc({ contentType: "audio/mpeg" }))).toBe(
      "audio",
    );
    expect(documentMediaFormat(doc({ contentType: "video/mp4" }))).toBe(
      "video",
    );
  });

  it("buckets pdf/text/markdown/unknown as `doc`", () => {
    expect(documentMediaFormat(doc({ contentType: "application/pdf" }))).toBe(
      "doc",
    );
    expect(documentMediaFormat(doc({ contentType: "text/markdown" }))).toBe(
      "doc",
    );
    expect(documentMediaFormat(doc({ contentType: undefined }))).toBe("doc");
  });

  it("always classifies a transcript-backed record as `transcript`", () => {
    // Even when the stored mime is audio, the transcript signal wins — matching
    // the server's documentHubFacet so hub facet + counts agree across pages.
    expect(
      documentMediaFormat(
        doc({ contentType: "audio/wav", transcriptId: "t-1" }),
      ),
    ).toBe("transcript");
  });

  it("ignores a mime charset suffix", () => {
    expect(
      documentMediaFormat(doc({ contentType: "text/plain; charset=utf-8" })),
    ).toBe("doc");
    expect(documentMediaFormat(doc({ contentType: "IMAGE/PNG" }))).toBe(
      "image",
    );
  });
});

describe("documentMatchesFacet", () => {
  it("`all` matches every record", () => {
    expect(documentMatchesFacet(doc({ contentType: "image/png" }), "all")).toBe(
      true,
    );
  });

  it("matches only the record's own facet", () => {
    const image = doc({ contentType: "image/png" });
    expect(documentMatchesFacet(image, "image")).toBe(true);
    expect(documentMatchesFacet(image, "doc")).toBe(false);
  });
});

describe("knowledgeFacetCounts", () => {
  it("counts each facet and the `all` total", () => {
    const counts = knowledgeFacetCounts([
      doc({ id: "1", contentType: "image/png" }),
      doc({ id: "2", contentType: "image/jpeg" }),
      doc({ id: "3", contentType: "application/pdf" }),
      doc({ id: "4", contentType: "audio/mpeg", transcriptId: "t" }),
    ]);
    expect(counts).toMatchObject({
      all: 4,
      image: 2,
      doc: 1,
      transcript: 1,
      audio: 0,
      video: 0,
    });
  });
});

describe("knowledgeReaderKind — reader branch splits `doc` into pdf vs text", () => {
  it("routes a transcript-backed record to the word-synced player", () => {
    expect(
      knowledgeReaderKind({ contentType: "audio/wav", transcriptId: "t" }),
    ).toBe("transcript");
  });

  it("splits pdf from prose text (unlike the list facet)", () => {
    expect(knowledgeReaderKind({ contentType: "application/pdf" })).toBe("pdf");
    expect(knowledgeReaderKind({ contentType: "text/markdown" })).toBe("text");
  });

  it("reads plain media by mime", () => {
    expect(knowledgeReaderKind({ contentType: "image/png" })).toBe("image");
    expect(knowledgeReaderKind({ contentType: "audio/mpeg" })).toBe("audio");
    expect(knowledgeReaderKind({ contentType: "video/mp4" })).toBe("video");
  });
});
