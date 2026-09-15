/** Verifies downloadable evidence preserves typed audio bits while its UI preview omits only payload arrays. */
import { expect, it } from "vitest";
import {
  serializeVoiceWorkbenchReport,
  voiceWorkbenchReportPreview,
} from "./voice-workbench-artifact";
import type { VoiceWorkbenchReport } from "./voice-workbench-player";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected artifact object");
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected artifact list");
  return value;
}
function decodedBytes(value: unknown): Uint8Array {
  const array = record(value);
  if (array.encoding !== "base64" || typeof array.data !== "string")
    throw new Error("Expected explicit encoded array");
  return Uint8Array.from(atob(array.data), (character) =>
    character.charCodeAt(0),
  );
}

it("round-trips complete offset byte arrays and Float32 payload bits, preserving source order and metadata", () => {
  const bytes = new Uint8Array([99, 0, 255, 128, 1, 77]).subarray(1, 5);
  const words = new Uint32Array([
    0, 0x80000000, 0x7fc01234, 0x3e800000, 0x7f800000,
  ]);
  const channel = new Float32Array(words.buffer).subarray(1);
  const report: VoiceWorkbenchReport = {
    schemaVersion: 1,
    overall: "skipped",
    scenarioId: "typed-audio",
    classes: [],
    platform: "web",
    ttsRoute: "/api/tts/cloud",
    startedAt: "2026-09-15T00:00:00Z",
    finishedAt: "2026-09-15T00:00:01Z",
    diarization: {
      status: "skipped",
      total: 0,
      der: 0,
      confusions: 0,
      unattributed: 1,
      maxDer: 0.1,
      evaluated: false,
      passed: false,
    },
    turns: [
      {
        index: 0,
        speaker: "owner",
        expectedSpeakerLabel: "owner",
        predictedSpeakerLabel: null,
        status: "pass",
        responded: true,
        expectRespond: true,
        transcript: "Complete input",
        expectedTranscript: "Complete input",
        reply: "Complete reply",
        durationMs: 1000,
        detail: { ttsObservation: "buffered-playback" },
        playbackEvidence: [
          {
            kind: "encoded",
            taskId: "task",
            atMs: 10,
            requestId: 1,
            origin: "response",
            bytes,
          },
          {
            kind: "decoded",
            taskId: "task",
            atMs: 20,
            bufferId: 1,
            sampleRate: 48000,
            channels: [channel, new Float32Array([0.5, -0.5])],
          },
          {
            kind: "source-started",
            taskId: "task",
            atMs: 30,
            bufferId: 1,
            audioTime: 0,
          },
          {
            kind: "terminal",
            taskId: "task",
            atMs: 40,
            outcome: "source-ended",
            audioTime: 1,
          },
        ],
      },
    ],
  };
  const serialized = serializeVoiceWorkbenchReport(report);
  const artifact = record(JSON.parse(serialized) as unknown);
  expect(artifact.schema).toBe("eliza.voice-workbench.playback.v1");
  const events = list(
    record(list(record(artifact.report).turns)[0]).playbackEvidence,
  ).map(record);
  expect(decodedBytes(events[0]?.bytes)).toEqual(bytes);
  const channels = list(events[1]?.channels);
  expect(decodedBytes(channels[0])).toEqual(
    new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength),
  );
  expect(record(channels[0])).toMatchObject({
    elementType: "Float32Array",
    length: channel.length,
  });
  expect(events.map((event) => event.kind)).toEqual(
    report.turns[0]?.playbackEvidence?.map((event) => event.kind),
  );
  expect(events[1]?.sampleRate).toBe(48000);
  for (const [index, encodedChannel] of channels.entries()) {
    const metadata = record(encodedChannel);
    if (metadata.byteOrder !== "little" && metadata.byteOrder !== "big")
      throw new Error("Missing Float32 byte order");
    const raw = decodedBytes(encodedChannel);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const reconstructed = Array.from(
      { length: raw.byteLength / 4 },
      (_, offset) =>
        view.getFloat32(offset * 4, metadata.byteOrder === "little"),
    );
    const original = index === 0 ? channel : new Float32Array([0.5, -0.5]);
    expect(reconstructed).toEqual(Array.from(original));
    expect(metadata.length).toBe(original.length);
  }
  const preview = voiceWorkbenchReportPreview(report);
  expect(preview.turns[0]?.playbackEvidence?.[0]).toMatchObject({
    kind: "encoded",
    byteLength: bytes.length,
  });
  expect(preview.turns[0]?.playbackEvidence?.[1]).toMatchObject({
    kind: "decoded",
    channelLengths: [4, 2],
  });
  const previewEvents = list(
    record(list(record(JSON.parse(JSON.stringify(preview))).turns)[0])
      .playbackEvidence,
  ).map(record);
  expect(previewEvents[0]).not.toHaveProperty("bytes");
  expect(previewEvents[1]).not.toHaveProperty("channels");
  expect(events[0]).toHaveProperty("bytes");
  expect(events[1]).toHaveProperty("channels");
  expect(serializeVoiceWorkbenchReport(report)).toBe(serialized);
});
