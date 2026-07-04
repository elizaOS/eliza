/**
 * Unit tests for the transcript-mirror knowledge backfill (#13593):
 * computeTranscriptBackfillMetadata adds roomId + media-format:transcript to
 * mirrors missing them, preserves transcriptId/audioUrl links, and is
 * idempotent (a fully-tagged record yields null). backfillTranscriptKnowledgeTags
 * only updates the records that need it and is a no-op on re-run.
 */
import type { Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  backfillTranscriptKnowledgeTags,
  computeTranscriptBackfillMetadata,
} from "./attachment-knowledge-backfill.ts";

const ROOM_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;

function doc(
  id: string,
  metadata: Record<string, unknown>,
  roomId = ROOM_ID,
): Memory {
  return {
    id: id as UUID,
    entityId: "00000000-0000-0000-0000-0000000000b1" as UUID,
    agentId: "00000000-0000-0000-0000-0000000000c1" as UUID,
    roomId,
    content: { text: "transcript body" },
    metadata,
    createdAt: Date.now(),
  } as Memory;
}

describe("computeTranscriptBackfillMetadata", () => {
  it("adds roomId + media-format tag/facet to a legacy transcript mirror", () => {
    const memory = doc("d1", {
      source: "transcript",
      tags: ["transcript"],
      transcriptId: "t-1",
      audioUrl: "/api/media/aa.mp3",
    });
    const patched = computeTranscriptBackfillMetadata(memory);
    expect(patched).not.toBeNull();
    expect(patched?.roomId).toBe(ROOM_ID);
    expect(patched?.mediaFormat).toBe("transcript");
    expect(patched?.tags).toEqual(["transcript", "media-format:transcript"]);
    // Links preserved.
    expect(patched?.transcriptId).toBe("t-1");
    expect(patched?.audioUrl).toBe("/api/media/aa.mp3");
  });

  it("detects a mirror by transcriptId even without the transcript tag", () => {
    const memory = doc("d2", { transcriptId: "t-2", tags: [] });
    const patched = computeTranscriptBackfillMetadata(memory);
    expect(patched?.mediaFormat).toBe("transcript");
    expect(patched?.tags).toContain("media-format:transcript");
  });

  it("is idempotent: a fully-tagged mirror yields null", () => {
    const memory = doc("d3", {
      source: "transcript",
      tags: ["transcript", "media-format:transcript"],
      transcriptId: "t-3",
      mediaFormat: "transcript",
      roomId: ROOM_ID,
    });
    expect(computeTranscriptBackfillMetadata(memory)).toBeNull();
  });

  it("ignores non-transcript documents", () => {
    const memory = doc("d4", {
      source: "upload",
      tags: ["attachment", "media-format:image"],
    });
    expect(computeTranscriptBackfillMetadata(memory)).toBeNull();
  });
});

describe("backfillTranscriptKnowledgeTags", () => {
  it("updates only the records that need it and is a no-op on re-run", async () => {
    const legacy = doc("m1", {
      source: "transcript",
      tags: ["transcript"],
      transcriptId: "t-1",
    });
    const alreadyTagged = doc("m2", {
      source: "transcript",
      tags: ["transcript", "media-format:transcript"],
      transcriptId: "t-2",
      mediaFormat: "transcript",
      roomId: ROOM_ID,
    });
    const notATranscript = doc("m3", {
      source: "upload",
      tags: ["attachment", "media-format:pdf"],
    });

    const store = new Map<string, Memory>([
      ["m1", legacy],
      ["m2", alreadyTagged],
      ["m3", notATranscript],
    ]);

    const runtime = {
      agentId: "00000000-0000-0000-0000-0000000000c1" as UUID,
      getMemories: vi.fn(async () => [...store.values()]),
      updateMemory: vi.fn(
        async (patch: { id: UUID; metadata?: Record<string, unknown> }) => {
          const existing = store.get(patch.id);
          if (existing) {
            store.set(patch.id, {
              ...existing,
              metadata: patch.metadata,
            } as Memory);
          }
          return true;
        },
      ),
    } as never;

    const updated = await backfillTranscriptKnowledgeTags(runtime);
    expect(updated).toBe(1);
    const m1Meta = store.get("m1")?.metadata as
      | Record<string, unknown>
      | undefined;
    expect(m1Meta?.mediaFormat).toBe("transcript");
    expect(m1Meta?.roomId).toBe(ROOM_ID);

    // Re-run: everything already tagged → no updates.
    const updatedAgain = await backfillTranscriptKnowledgeTags(runtime);
    expect(updatedAgain).toBe(0);
  });
});
