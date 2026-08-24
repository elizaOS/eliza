/**
 * Unit tests for MOCK_DIARIZATION_PIPELINE: an empty audioRef yields no
 * segments, and a non-empty ref returns two deterministic mock speaker
 * segments with ordered, non-degenerate time ranges.
 */
import { describe, expect, it } from "vitest";
import { MOCK_DIARIZATION_PIPELINE } from "../diarization-pipeline.ts";

describe("MOCK_DIARIZATION_PIPELINE", () => {
  it("returns empty for empty audioRef", async () => {
    expect(await MOCK_DIARIZATION_PIPELINE.diarize("")).toEqual([]);
  });

  it("returns deterministic mock segments for a non-empty ref", async () => {
    const segs = await MOCK_DIARIZATION_PIPELINE.diarize("file://demo.wav");
    expect(segs.length).toBe(2);
    expect(segs[0]?.profileId).toBe("mock-speaker-a");
    expect(segs[1]?.profileId).toBe("mock-speaker-b");
    expect(segs[0]?.endMs).toBeGreaterThan(segs[0]?.startMs ?? 0);
  });

  it("returns the exact mock segment payload for a non-empty ref", async () => {
    const segs = await MOCK_DIARIZATION_PIPELINE.diarize("file://demo.wav");
    expect(segs).toEqual([
      {
        startMs: 0,
        endMs: 1_000,
        profileId: "mock-speaker-a",
        confidence: 0.8,
      },
      {
        startMs: 1_000,
        endMs: 2_000,
        profileId: "mock-speaker-b",
        confidence: 0.7,
      },
    ]);
  });

  it("orders segments in time with valid confidences and no overlap", async () => {
    const segs = await MOCK_DIARIZATION_PIPELINE.diarize("file://demo.wav");
    for (const seg of segs) {
      expect(seg.endMs).toBeGreaterThan(seg.startMs);
      expect(seg.confidence).toBeGreaterThanOrEqual(0);
      expect(seg.confidence).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i]?.startMs).toBeGreaterThanOrEqual(segs[i - 1]?.endMs ?? 0);
    }
  });

  it("treats a whitespace-only ref as non-empty", async () => {
    const segs = await MOCK_DIARIZATION_PIPELINE.diarize(" ");
    expect(segs.length).toBe(2);
  });

  it("is deterministic across repeated calls", async () => {
    const first = await MOCK_DIARIZATION_PIPELINE.diarize("file://demo.wav");
    const second = await MOCK_DIARIZATION_PIPELINE.diarize("file://demo.wav");
    expect(second).toEqual(first);
  });

  it("returns an independent array on every call", async () => {
    const first = await MOCK_DIARIZATION_PIPELINE.diarize("file://demo.wav");
    first.pop();
    const second = await MOCK_DIARIZATION_PIPELINE.diarize("file://demo.wav");
    expect(second.length).toBe(2);
  });
});
