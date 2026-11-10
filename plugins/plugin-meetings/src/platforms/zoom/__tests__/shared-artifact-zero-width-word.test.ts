/**
 * Timed ASR may return a zero-width word: its contract is
 * `0 <= startMs <= endMs` (`validateAsrWordTimings`), and the meeting
 * transcriber accepts such a result. The shared meeting artifact needs
 * `endMs > startMs`, so the Zoom bot projection must widen those spans
 * instead of failing the whole transcript.
 *
 * Real SQLite runtime, the production `createMeetingTranscriptionPipeline`
 * with its default runtime-model ASR backend, and the real `MeetingService`.
 * Only the native timed ASR engine (a registered `timedAsr` service) and the
 * Zoom browser adapter are scripted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IAgentRuntime, Service } from "@elizaos/core";
import {
  type MeetingArtifact,
  validateAsrWordTimings,
  validateMeetingArtifact,
} from "@elizaos/core/protocol";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMeetingTranscriptionPipeline } from "../../../pipeline/pipeline.js";
import { MeetingService } from "../../../service.js";
import { ScriptedAdapter } from "../../../test-support.js";
import { readTranscriptRow } from "../../../transcripts/meeting-transcript-writer.js";
import { buildZoomBotMeetingArtifact } from "../shared-artifact.js";

// Word-timed ASR output for "Okay, a quick update.": the one-letter word got a
// zero-width span from the char-proportional timing.
const TIMED_WORDS = [
  { text: "Okay,", startMs: 0, endMs: 300 },
  { text: "a", startMs: 300, endMs: 300 },
  { text: "quick", startMs: 300, endMs: 600 },
  { text: "update.", startMs: 600, endMs: 900 },
];

class ScriptedTimedAsrService extends Service {
  static override serviceType = "timedAsr";
  override capabilityDescription = "Scripted word-timed ASR for tests.";
  static override async start(
    runtime: IAgentRuntime,
  ): Promise<ScriptedTimedAsrService> {
    return new ScriptedTimedAsrService(runtime);
  }
  isAvailable(): boolean {
    return true;
  }
  async transcribeWav(): Promise<{
    text: string;
    words: typeof TIMED_WORDS;
  }> {
    return { text: "Okay, a quick update.", words: TIMED_WORDS };
  }
  override async stop(): Promise<void> {}
}

const runtimes: Array<ReturnType<typeof createSQLiteTestRuntime>> = [];
let stateDir = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.ELIZA_STATE_DIR;
  stateDir = mkdtempSync(join(tmpdir(), "eliza-zoom-zero-width-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
    await runtime.close();
  }
  if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = previousStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

async function runtimeWithTimedAsr() {
  const runtime = createSQLiteTestRuntime({
    character: { name: "ZoomZeroWidth" },
  });
  await runtime.initialize({ skipMigrations: true });
  runtimes.push(runtime);
  await runtime.registerService(ScriptedTimedAsrService);
  await runtime.getServiceLoadPromise("timedAsr");
  return runtime;
}

function wordA(artifact: MeetingArtifact) {
  return artifact.transcriptSpans
    .flatMap((span) => span.words)
    .find((word) => word.text === "a");
}

describe("Zoom bot artifact with a zero-width timed ASR word", () => {
  it("the scripted words satisfy the timed ASR contract", () => {
    expect(validateAsrWordTimings(TIMED_WORDS).ok).toBe(true);
  });

  it("projects a transcriber segment with a zero-width word into a valid artifact", async () => {
    const runtime = await runtimeWithTimedAsr();
    const pipeline = createMeetingTranscriptionPipeline({
      runtime,
      sessionId: "00000000-0000-4000-8000-0000000000c1",
      retainAudio: true,
    });
    pipeline.setSpeakerName("spk-1", "Alice");
    pipeline.pushSpeakerAudio("spk-1", new Float32Array(16_000).fill(0.1));
    const segments = await pipeline.finalize();
    expect(segments).toHaveLength(1);
    expect(segments[0]?.words.some((w) => w.endMs === w.startMs)).toBe(true);

    const artifact = buildZoomBotMeetingArtifact({
      artifactId: "zoom-bot:zero-width",
      meetingId: "1234567890",
      title: "Zoom meeting 1234567890",
      endedAt: new Date().toISOString(),
      participants: [{ id: "zoom-alice", displayName: "Alice" }],
      segments,
      audio: {
        id: "a".repeat(64),
        url: `/api/media/${"a".repeat(64)}.wav`,
        checksum: `sha256:${"a".repeat(64)}`,
        mimeType: "audio/wav",
      },
    });

    expect(validateMeetingArtifact(artifact)).toEqual({
      valid: true,
      errors: [],
    });
    expect(artifact.transcriptSpans[0]?.text).toBe("Okay, a quick update.");
    const word = wordA(artifact);
    expect(word).toBeDefined();
    expect(word?.endMs).toBe((word?.startMs ?? 0) + 1);
  });

  it("saves the Zoom bot transcript and artifact when timed ASR returns a zero-width word", async () => {
    const runtime = await runtimeWithTimedAsr();
    const adapter = new ScriptedAdapter("zoom");
    const service = new MeetingService(runtime, {
      adapters: new Map([["zoom", adapter]]),
      createPipeline: createMeetingTranscriptionPipeline,
    });
    const dto = await service.requestJoin({
      platform: "zoom",
      meetingUrl: "https://zoom.us/j/1234567890",
    });
    const bot = await adapter.started;
    bot.reportStatus("active");
    bot.sink.participantJoined({ id: "zoom-alice", displayName: "Alice" });
    bot.sink.setSpeakerName("spk-1", "Alice");
    bot.sink.pushSpeakerAudio("spk-1", new Float32Array(16_000).fill(0.1));
    adapter.end("normal_completion");

    for (let i = 0; i < 100; i++) {
      const status = service.getSession(dto.id)?.status;
      if (status === "ended" || status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const finished = service.getSession(dto.id);
    expect(finished?.errorMessage).toBeUndefined();
    expect(finished?.status).toBe("ended");

    const row = await runtime.getMemoryById(dto.transcriptId as never);
    const transcript = row ? readTranscriptRow(row) : null;
    expect(transcript?.segments[0]?.text).toBe("Okay, a quick update.");
    const artifact = transcript?.metadata?.meetingArtifact as
      | MeetingArtifact
      | undefined;
    expect(artifact).toBeDefined();
    if (!artifact) return;
    expect(validateMeetingArtifact(artifact)).toEqual({
      valid: true,
      errors: [],
    });
    const word = wordA(artifact);
    expect(word?.endMs).toBe((word?.startMs ?? 0) + 1);
  });
});
