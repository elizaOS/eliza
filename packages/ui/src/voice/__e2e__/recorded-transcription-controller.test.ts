import { describe, expect, it, vi } from "vitest";
import {
  RecordedTranscriptionController,
  type RecordedTranscriptionOptions,
} from "../recorded-transcription-controller";

// Fake stream and recorder; not microphone, codec or transcription evidence.
function setup(
  finalTranscript?: RecordedTranscriptionOptions["finalTranscript"],
  overrides: Partial<RecordedTranscriptionOptions> = {},
) {
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
    ...overrides,
  });
  return { controller, recorder, encode, transcribe };
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

describe("RecordedTranscriptionController final snapshot", () => {
  it("keeps the preview capture open for a last snapshot after a time-limit stop", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const transcripts: [string, boolean][] = [];
      let words = "Hello";
      let snapshot: (() => Promise<void>) | undefined;
      const encode = vi.fn(async (blob: Blob) => blob.text());
      const { controller, recorder } = setup(
        async () => {
          events.push(`final:${recorder.state}`);
          await snapshot?.();
          const latest = transcripts.filter(([, final]) => !final).at(-1);
          return latest ? { text: latest[0] } : undefined;
        },
        {
          maximumMs: 5_000,
          encode,
          transcribe: vi.fn(async (audio: string) => ({ text: audio })),
          preview: async (_stream, receive) => {
            snapshot = async () => {
              events.push("snapshot");
              await receive(new Blob([words], { type: "audio/wav" }));
            };
            return () => events.push("close-preview");
          },
        },
      );
      await controller.start(
        (text, final) => transcripts.push([text, final]),
        () => () => {},
      );
      await snapshot?.(); // the last polling tick
      words = "Hello, it is me."; // spoken after that tick
      await vi.advanceTimersByTimeAsync(5_000); // maximumMs stops the recorder
      await vi.waitFor(() => expect(controller.pending).toBe(false));
      expect(events).toEqual([
        "snapshot",
        "final:inactive",
        "snapshot",
        "close-preview",
      ]);
      expect(transcripts.at(-1)).toEqual(["Hello, it is me.", true]);
      // Only the two WAV previews were encoded, never the Opus recording.
      expect(encode).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the preview capture at stop by default", async () => {
    const events: string[] = [];
    const { controller } = setup(undefined, {
      preview: async () => () => events.push("close-preview"),
    });
    await controller.start(
      () => {},
      () => () => {},
    );
    controller.finish();
    expect(events).toEqual(["close-preview"]);
    await vi.waitFor(() => expect(controller.pending).toBe(false));
  });
});
