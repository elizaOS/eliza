import { describe, expect, it, vi } from "vitest";
import {
  RecordedTranscriptionController,
  type RecordedTranscriptionOptions,
} from "../recorded-transcription-controller";

// Fake stream and recorder; not microphone, codec or transcription evidence.
function setup(finalTranscript?: RecordedTranscriptionOptions["finalTranscript"]) {
  const recorder = {
    state: "inactive",
    mimeType: "audio/webm;codecs=opus",
    ondataavailable: null as ((event: { data: Blob }) => void) | null,
    onstop: null as (() => void) | null,
    onerror: null,
    start() {
      this.state = "recording";
    },
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["opus"]) });
      this.onstop?.();
    },
  };
  const encode = vi.fn(async () => "b3B1cw==");
  const transcribe = vi.fn(async () => ({ text: "From the recording." }));
  const controller = new RecordedTranscriptionController({
    authorize: async () => {},
    encode,
    transcribe,
    finalTranscript,
    preview: async () => undefined,
    changed: () => {},
    maximumBytes: 1_000_000,
    maximumMs: 60_000,
    timesliceMs: 250,
    constraints: { audio: true },
    mimeTypes: ["audio/webm;codecs=opus"],
    environment: {
      acquire: async () =>
        ({ getTracks: () => [{ stop() {} }] }) as unknown as MediaStream,
      recorder: () => recorder as unknown as MediaRecorder,
    },
  });
  return { controller, encode, transcribe };
}

async function record(controller: RecordedTranscriptionController) {
  const transcripts: [string, boolean][] = [];
  await controller.start(
    (text, final) => transcripts.push([text, final]),
    () => () => {},
  );
  controller.finish();
  await vi.waitFor(() => expect(controller.pending).toBe(false));
  return transcripts;
}

describe("RecordedTranscriptionController final transcript", () => {
  it("encodes and transcribes the recording by default", async () => {
    const { controller, encode, transcribe } = setup();
    expect(await record(controller)).toEqual([["From the recording.", true]]);
    expect(encode).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledWith(
      "b3B1cw==",
      "audio/webm;codecs=opus",
    );
  });

  it("uses the host transcript and skips encoding the recording", async () => {
    const { controller, encode, transcribe } = setup(async () => ({
      text: "From the host.",
    }));
    expect(await record(controller)).toEqual([["From the host.", true]]);
    expect(encode).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("falls back to the recording when the host has no transcript", async () => {
    const { controller, encode } = setup(async () => undefined);
    expect(await record(controller)).toEqual([["From the recording.", true]]);
    expect(encode).toHaveBeenCalledOnce();
  });
});
