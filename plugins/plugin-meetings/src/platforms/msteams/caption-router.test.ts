/**
 * Teams caption routing through a real MeetingService session on an in-memory
 * SQLite runtime. The router holds RMS-gated chunks until a caption names
 * their speaker, then drains the batch in one synchronous loop; the session
 * audio stored with the transcript must still lay those chunks end to end at
 * the time they were captured, and the transcript segment must start where
 * that speech starts in the recording. Only the meeting page and the
 * TRANSCRIPTION model are stand-ins.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { createMeetingTranscriptionPipeline } from "../../pipeline/pipeline.js";
import { wavToFloat32 } from "../../pipeline/wav.js";
import { MeetingService } from "../../service.js";
import { ScriptedAdapter } from "../../test-support.js";
import { readTranscriptRow } from "../../transcripts/meeting-transcript-writer.js";
import { MEETING_AUDIO_SAMPLE_RATE } from "../../types.js";
import { TeamsCaptionRouter } from "./caption-router.js";

const TEAMS_URL = "https://teams.microsoft.com/meet/4459812307";
/** page-capture.ts ScriptProcessor buffer: 4096 samples = 256 ms at 16 kHz. */
const CHUNK_SAMPLES = 4096;
const CHUNK_MS = (CHUNK_SAMPLES / MEETING_AUDIO_SAMPLE_RATE) * 1000;

it("stores a caption-delayed batch of Teams audio and its segment at its capture time", async () => {
  const previousStateDir = process.env.ELIZA_STATE_DIR;
  const stateDir = mkdtempSync(join(tmpdir(), "eliza-teams-audio-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  vi.useFakeTimers({ toFake: ["Date"] });
  const runtime = createSQLiteTestRuntime({
    character: { name: "Notetaker", bio: ["test"] },
    logLevel: "fatal",
    plugins: [
      {
        name: "scripted-transcription",
        description: "Hears the caption's words in every meeting window",
        models: {
          [ModelType.TRANSCRIPTION]: async () => "Good morning everyone",
        },
      },
    ],
  });
  await runtime.initialize({ skipMigrations: true });
  try {
    const adapter = new ScriptedAdapter("teams");
    const service = new MeetingService(runtime, {
      adapters: new Map([["teams", adapter]]),
      createPipeline: createMeetingTranscriptionPipeline,
    });
    const t0 = Date.now();
    const dto = await service.requestJoin({
      platform: "teams",
      meetingUrl: TEAMS_URL,
    });
    const session = await adapter.started;
    // Wired exactly as the Teams strategy's prepare() does.
    const router = new TeamsCaptionRouter({
      sink: session.sink,
      botName: session.config.botName,
    });

    // One second of speech arrives as four chunks while the caption lags.
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(t0 + 5_000 + i * CHUNK_MS);
      router.onAudioChunk(new Float32Array(CHUNK_SAMPLES).fill(0.1));
    }
    // 1.5 s later the caption names the speaker and the queue drains at once.
    vi.setSystemTime(t0 + 6_500);
    router.onCaption("Alice", "Good morning everyone");
    router.finalize();
    adapter.end("normal_completion");

    await vi.waitFor(
      () => {
        expect(service.getSession(dto.id)?.status).toBe("ended");
      },
      { timeout: 10_000 },
    );
    const row = await runtime.getMemoryById(dto.transcriptId as never);
    const transcript = row ? readTranscriptRow(row) : null;
    if (!transcript?.audioUrl) throw new Error("Expected stored session audio");
    const wav = readFileSync(
      join(stateDir, "media", basename(transcript.audioUrl)),
    );
    const { samples } = wavToFloat32(wav);

    let first = -1;
    let last = -1;
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i] === 0) continue;
      if (first < 0) first = i;
      last = i;
      peak = Math.max(peak, samples[i]);
    }
    // Every captured sample is audible once, at the level it was captured,
    // starting where the first chunk arrived (5 s into the session).
    expect({ first, voiced: last - first + 1 }).toEqual({
      first: 5 * MEETING_AUDIO_SAMPLE_RATE,
      voiced: 4 * CHUNK_SAMPLES,
    });
    expect(peak).toBeCloseTo(0.1, 3);
    // The segment for that speech starts at the same point in the recording,
    // not where the caption released the batch (6.5 s).
    expect(transcript.segments.map((segment) => segment.startMs)).toEqual([
      (first / MEETING_AUDIO_SAMPLE_RATE) * 1000,
    ]);
  } finally {
    vi.useRealTimers();
    await runtime.stop();
    if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
