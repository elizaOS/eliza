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
});
