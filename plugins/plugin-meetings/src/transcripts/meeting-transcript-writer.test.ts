/**
 * MeetingTranscriptWriter — the persisted record shape (golden, parsed with the
 * transcripts-reader logic), finalize edges, throttling, and content-addressed
 * WAV retention. Deterministic: real fs in a temp dir.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Memory, UUID } from "@elizaos/core";
import {
  summarizeTranscript,
  type Transcript,
  transcriptPreview,
} from "@elizaos/shared/transcripts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeRuntime, segment } from "../test-support.js";
import {
  MeetingTranscriptWriter,
  persistMeetingAudioWav,
  readTranscriptRow,
  TRANSCRIPTS_TABLE,
} from "./meeting-transcript-writer.js";

/**
 * GOLDEN READER — a byte-for-byte copy of `rowToTranscript` from
 * plugin-local-inference's transcripts-routes read path
 * (src/services/voice/transcript-store.ts). The rows this writer persists MUST
 * parse through this exact logic, because that is how the /api/transcripts
 * routes and the Transcripts view will load them.
 */
function transcriptsViewReader(row: Memory): Transcript | null {
  const raw = (row.content as { transcript?: unknown }).transcript;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Transcript) : null;
  } catch {
    return null;
  }
}

const START_INPUT = {
  sessionId: "11111111-1111-1111-1111-111111111111" as UUID,
  worldId: "22222222-2222-2222-2222-222222222222" as UUID,
  roomId: "33333333-3333-3333-3333-333333333333" as UUID,
  entityId: "44444444-4444-4444-4444-444444444444" as UUID,
  title: "Google Meet meeting abc-defg-hij",
  platform: "google_meet" as const,
  meetingUrl: "https://meet.google.com/abc-defg-hij",
  nativeMeetingId: "abc-defg-hij",
};

describe("MeetingTranscriptWriter — record shape golden", () => {
  it("persists a row the transcripts-routes reader parses at every lifecycle stage", async () => {
    const fake = makeFakeRuntime();
    const writer = new MeetingTranscriptWriter(fake.runtime, 0);
    await writer.start(START_INPUT);

    // Partition + row identity.
    expect(fake.tables.get(writer.transcriptId)).toBe(TRANSCRIPTS_TABLE);
    const recordingRow = fake.memories.get(writer.transcriptId);
    expect(recordingRow?.id).toBe(writer.transcriptId);
    expect(recordingRow?.metadata).toMatchObject({
      type: "custom",
      source: "transcript",
      transcriptId: writer.transcriptId,
      status: "recording",
    });

    // The recording row parses through the EXACT view reader.
    const recording = transcriptsViewReader(recordingRow as Memory);
    expect(recording).not.toBeNull();
    expect(recording?.status).toBe("recording");
    expect(recording?.source).toBe("meeting");
    expect(recording?.scope).toBe("owner-private");
    expect(summarizeTranscript(recording as Transcript).id).toBe(
      writer.transcriptId,
    );

    // Incremental update: preview text + timing metadata stay consistent.
    const segments = [
      segment("s1", "Jill", "hello there", 0, 1_500),
      segment("s2", "Bob", "hi jill", 1_500, 3_000),
    ];
    writer.updateSegments(segments);
    await new Promise((r) => setTimeout(r, 5));
    const liveRow = fake.memories.get(writer.transcriptId) as Memory;
    const live = transcriptsViewReader(liveRow);
    expect(live?.segments).toHaveLength(2);
    expect(live?.speakerCount).toBe(2);
    expect(live?.durationMs).toBe(3_000);
    expect(liveRow.content.text).toBe(transcriptPreview(segments));
    expect(liveRow.metadata).toMatchObject({
      durationMs: 3_000,
      speakerCount: 2,
    });

    // Finalize: ready + endedAt + participants + knowledge mirror.
    const final = await writer.finalize({
      segments,
      endReason: "normal_completion",
      participants: [{ id: "p1", displayName: "Jill" }],
      audioWav: null,
    });
    const finalRow = fake.memories.get(writer.transcriptId) as Memory;
    const readBack = transcriptsViewReader(finalRow);
    expect(readBack).toEqual(final);
    expect(readBack?.status).toBe("ready");
    expect(readBack?.endedAt).toBeTypeOf("number");
    expect(readBack?.metadata).toMatchObject({
      platform: "google_meet",
      nativeMeetingId: "abc-defg-hij",
      endReason: "normal_completion",
    });
    // Local reader helper agrees with the view reader.
    expect(readTranscriptRow(finalRow)).toEqual(readBack);
    // Knowledge mirror: tag "transcript", clientDocumentId = transcript id, textBacked.
    expect(fake.documents).toHaveLength(1);
    expect(fake.documents[0]).toMatchObject({
      clientDocumentId: writer.transcriptId,
      contentType: "text/plain",
      addedFrom: "runtime-internal",
    });
    expect(fake.documents[0].content).toBe("Jill: hello there\nBob: hi jill");
    expect(fake.documents[0].metadata).toMatchObject({
      tags: ["transcript"],
      textBacked: true,
      transcriptId: writer.transcriptId,
    });
    expect(readBack?.knowledgeDocumentId).toBeTypeOf("string");
  });

  it("survives a missing documents service (record persists without mirror)", async () => {
    const fake = makeFakeRuntime();
    const base = fake.runtime.getService.bind(fake.runtime);
    (fake.runtime as { getService: (n: string) => unknown }).getService = (
      name: string,
    ) => (name === "documents" ? null : base(name));
    const writer = new MeetingTranscriptWriter(fake.runtime, 0);
    await writer.start(START_INPUT);
    const final = await writer.finalize({
      segments: [segment("s1", "Jill", "hi", 0, 500)],
      endReason: "requested_stop",
      participants: [],
      audioWav: null,
    });
    expect(final.status).toBe("ready");
    expect(final.knowledgeDocumentId).toBeUndefined();
    expect(fake.documents).toHaveLength(0);
  });
});

describe("MeetingTranscriptWriter — finalize edges", () => {
  it("finalizes an empty meeting to status ready with 0 speakers and no segments", async () => {
    const fake = makeFakeRuntime();
    const writer = new MeetingTranscriptWriter(fake.runtime, 0);
    await writer.start(START_INPUT);
    const final = await writer.finalize({
      segments: [],
      endReason: "left_alone_timeout",
      participants: [],
      audioWav: null,
    });
    expect(final.status).toBe("ready");
    expect(final.segments).toHaveLength(0);
    expect(final.speakerCount).toBe(0);
    expect(final.durationMs).toBe(0);
    // No transcript text → nothing to mirror into knowledge.
    expect(fake.documents).toHaveLength(0);
    expect(final.knowledgeDocumentId).toBeUndefined();
    // Row still parses through the view reader.
    const row = fake.memories.get(writer.transcriptId) as Memory;
    expect(transcriptsViewReader(row)?.status).toBe("ready");
  });

  it("skips the media write when audioWav is null but writes it when present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meetings-audiowav-"));
    const prev = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = dir;
    try {
      const segs = [segment("s1", "Jill", "hi there", 0, 800)];

      // audioWav null → no audioUrl, media dir stays empty.
      const fakeA = makeFakeRuntime();
      const writerA = new MeetingTranscriptWriter(fakeA.runtime, 0);
      await writerA.start(START_INPUT);
      const finalA = await writerA.finalize({
        segments: segs,
        endReason: "normal_completion",
        participants: [],
        audioWav: null,
      });
      expect(finalA.audioUrl).toBeUndefined();
      expect(finalA.audioContentType).toBeUndefined();

      // audioWav present → audioUrl set + content-addressed file on disk.
      const fakeB = makeFakeRuntime();
      const writerB = new MeetingTranscriptWriter(fakeB.runtime, 0);
      await writerB.start(START_INPUT);
      const wav = Buffer.from("RIFF-real-wav-payload-bytes");
      const finalB = await writerB.finalize({
        segments: segs,
        endReason: "normal_completion",
        participants: [],
        audioWav: wav,
      });
      expect(finalB.audioUrl).toMatch(/^\/api\/media\/[0-9a-f]{64}\.wav$/);
      expect(finalB.audioContentType).toBe("audio/wav");
      const hash = finalB.audioUrl?.slice("/api/media/".length) as string;
      expect(existsSync(join(dir, "media", hash))).toBe(true);

      // BL-3: the knowledge-mirror document must reference the WAV via
      // `metadata.mediaUrl` (the key the daily media GC scans on document rows).
      // Without it the retained audio is unreferenced and gets swept. `audioUrl`
      // is kept too for transcript readers.
      const mirrorMeta = fakeB.documents[0].metadata as {
        mediaUrl?: string;
        audioUrl?: string;
      };
      expect(mirrorMeta.mediaUrl).toBe(finalB.audioUrl);
      expect(mirrorMeta.audioUrl).toBe(finalB.audioUrl);
      // The audio-less mirror (writerA) carries neither key.
      const mirrorMetaA = fakeA.documents[0]?.metadata as
        | { mediaUrl?: string }
        | undefined;
      expect(mirrorMetaA?.mediaUrl).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ELIZA_STATE_DIR;
      else process.env.ELIZA_STATE_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a zero-length audioWav buffer as no audio", async () => {
    const fake = makeFakeRuntime();
    const writer = new MeetingTranscriptWriter(fake.runtime, 0);
    await writer.start(START_INPUT);
    const final = await writer.finalize({
      segments: [segment("s1", "Jill", "hi", 0, 500)],
      endReason: "normal_completion",
      participants: [],
      audioWav: Buffer.alloc(0),
    });
    expect(final.audioUrl).toBeUndefined();
  });
});

describe("MeetingTranscriptWriter — throttling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid segment updates to ~one write per throttle window", async () => {
    const fake = makeFakeRuntime();
    let writes = 0;
    const baseUpdate = fake.runtime.updateMemory.bind(fake.runtime);
    (
      fake.runtime as { updateMemory: typeof fake.runtime.updateMemory }
    ).updateMemory = async (patch) => {
      writes += 1;
      return baseUpdate(patch);
    };
    const writer = new MeetingTranscriptWriter(fake.runtime, 5_000, Date.now);
    await writer.start(START_INPUT);

    // 20 updates in one second — none should write before the window elapses.
    for (let i = 0; i < 20; i++) {
      writer.updateSegments([
        segment(`s${i}`, "Jill", `t${i}`, 0, 100 * (i + 1)),
      ]);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(writes).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toBe(1);
    const live = transcriptsViewReader(
      fake.memories.get(writer.transcriptId) as Memory,
    );
    expect(live?.segments[0].text).toBe("t19"); // latest state won
  });
});

describe("persistMeetingAudioWav", () => {
  it("writes content-addressed WAV bytes under the served media dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "meetings-audio-"));
    const prev = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = dir;
    try {
      const wav = Buffer.from("RIFF-fake-wav-bytes");
      const url = persistMeetingAudioWav(wav);
      expect(url).toMatch(/^\/api\/media\/[0-9a-f]{64}\.wav$/);
      const hash = url.slice("/api/media/".length);
      expect(existsSync(join(dir, "media", hash))).toBe(true);
      // Idempotent.
      expect(persistMeetingAudioWav(wav)).toBe(url);
    } finally {
      if (prev === undefined) delete process.env.ELIZA_STATE_DIR;
      else process.env.ELIZA_STATE_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
