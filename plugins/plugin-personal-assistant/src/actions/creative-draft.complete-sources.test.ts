/** Tests complete owner-voice source traversal at the prompt boundary. */

import type { DocumentService, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { resolveOwnerVoiceSources } from "./creative-draft.js";

describe("creative draft owner sources", () => {
  it("collects every page and normalizes supplied and stored text", async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) => ({
      id: `document-${index}`,
      entityId: "owner",
      roomId: "room",
      content: { text: `${"d".repeat(6_100)} document-tail-${index}` },
      metadata: { source: "note" },
    }));
    const pageTwo = Array.from({ length: 4 }, (_, index) => ({
      id: `document-${index + 100}`,
      entityId: "owner",
      roomId: "room",
      content: { text: `second-page-${index}` },
      metadata: { source: "note" },
    }));
    const listDocumentsDetailed = vi
      .fn()
      .mockResolvedValueOnce({
        documents: pageOne,
        hasMore: true,
        nextCursor: { createdAt: 1, id: "document-99" },
      })
      .mockResolvedValueOnce({
        documents: pageTwo,
        hasMore: false,
      });
    const service = { listDocumentsDetailed } as unknown as DocumentService;
    const suppliedText = `owner ${String.fromCharCode(0xd800)} supplied-tail`;

    const sources = await resolveOwnerVoiceSources({
      documents: service,
      message: { entityId: "owner" } as Memory,
      supplied: [{ id: "supplied", text: suppliedText, source: "essay" }],
    });

    expect(sources).toHaveLength(105);
    expect(sources[0]?.text.isWellFormed()).toBe(true);
    expect(sources[0]?.text).toContain("supplied-tail");
    expect(sources).toContainEqual(
      expect.objectContaining({ id: "document-103", text: "second-page-3" }),
    );
    expect(sources.find(({ id }) => id === "document-99")?.text).toContain(
      "document-tail-99",
    );
    expect(listDocumentsDetailed).toHaveBeenCalledTimes(2);
  });
});
