/** Exercises voice stream coordinator behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import { VoiceStreamCoordinator } from "./voice-stream-coordinator";

function coordinator(env: Record<string, string | undefined> = {}) {
  let tick = 0;
  return new VoiceStreamCoordinator({
    pipelineId: "voice-pipeline-1",
    env,
    now: () => new Date(Date.parse("2026-05-17T12:00:00.000Z") + tick++ * 10),
    turnIdFactory: () => "voice-turn-1",
  });
}

describe("VoiceStreamCoordinator", () => {
  it("keeps ASR partials local by default", async () => {
    const stream = coordinator();

    await stream.startTurn();
    const result = await stream.handleAsrPartial({ text: "hello" });

    expect(result).toEqual({
      mode: "disabled",
      runtimePrepareStarted: false,
    });
    expect(stream.snapshot()?.marks).not.toContainEqual(
      expect.objectContaining({ stage: "runtime", name: "prepare.started" }),
    );
  });

  it("uses prepare-only mode when partial streaming is enabled without a draft API", async () => {
    const stream = coordinator({ ELIZA_VOICE_STREAM_ASR_PARTIALS: "1" });

    await stream.startTurn();
    const result = await stream.handleAsrPartial({ text: "hello" });

    expect(result).toEqual({
      mode: "prepare-only",
      runtimePrepareStarted: true,
    });
    expect(stream.snapshot()?.marks).toContainEqual(
      expect.objectContaining({ stage: "runtime", name: "prepare.started" }),
    );
  });

  it("commits the ASR final once", async () => {
    const stream = coordinator();

    await stream.startTurn();
    await stream.handleAsrPartial({ text: "hello" });

    await expect(stream.handleAsrFinal({ text: "hello world" })).resolves.toBe(
      true,
    );
    await expect(stream.handleAsrFinal({ text: "hello world" })).resolves.toBe(
      false,
    );

    expect(
      stream
        .snapshot()
        ?.marks.filter(
          (mark) => mark.stage === "runtime" && mark.name === "runtime.started",
        ),
    ).toHaveLength(1);
  });

  it("records first-token latency and emits TTS chunks", async () => {
    const stream = new VoiceStreamCoordinator({
      pipelineId: "voice-pipeline-1",
      now: (() => {
        let tick = 0;
        return () =>
          new Date(Date.parse("2026-05-17T12:00:00.000Z") + tick++ * 10);
      })(),
      turnIdFactory: () => "voice-turn-1",
      env: {
        ELIZA_VOICE_TTS_CHUNK_MIN_CHARS: "8",
        ELIZA_VOICE_TTS_CHUNK_MAX_CHARS: "80",
      },
    });

    await stream.startTurn();
    await stream.handleAsrFinal({ text: "hello world" });
    const result = await stream.handleRuntimeDelta("This is ready.");

    expect(result.firstToken).toBe(true);
    expect(result.chunks).toEqual([
      {
        sequence: 1,
        text: "This is ready.",
        final: false,
        reason: "punctuation",
      },
    ]);
    expect(stream.latencySummary()?.runtimeToFirstTokenMs).toBeGreaterThan(0);
  });

  it("records playback and supports interruption", async () => {
    const stream = coordinator();

    await stream.startTurn();
    await stream.handleAsrFinal({ text: "hello world" });
    await stream.handleRuntimeDelta("response.");
    await stream.handleTtsFirstAudio();
    await stream.handlePlaybackStarted({ started: true });

    expect(stream.latencySummary()?.totalToPlaybackMs).toBeGreaterThan(0);

    await stream.interrupt("barge-in");
    expect(stream.snapshot()).toMatchObject({
      status: "interrupted",
      error: "barge-in",
    });
  });
});
