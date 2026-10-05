import { expect, spyOn, test } from "bun:test";
import {
  createNativeSpeechStream,
  type NativeSpeechRequest,
} from "./native-speech-stream.js";

const id = "12345678-1234-1234-1234-123456789abc";
const audio = {
  type: "audio",
  sequence: 0,
  audioBase64: "AQID",
  mimeType: "audio/mpeg",
  alignment: null,
  normalizedAlignment: null,
};
const started = { streamId: id, state: "open", renderedSpeed: 0.8 };
const input = { text: "Hello", speed: 0.8 };
test("lost start and pull replies retain identity and cursor; concurrent pulls share delivery", async () => {
  const calls: { path: string; body: object }[] = [];
  let startAttempts = 0,
    pulls = 0;
  const request: NativeSpeechRequest = async (path, body) => {
    calls.push({ path, body });
    if (path.endsWith("start")) {
      if (++startAttempts === 1) throw Error("lost start");
      return started;
    }
    if (++pulls === 1) throw Error("lost pull");
    return { cursor: 0, frame: audio };
  };
  const stream = createNativeSpeechStream(request, input, { requestId: id });
  await expect(stream.pull()).rejects.toThrow("lost start");
  await expect(stream.pull()).rejects.toThrow("lost pull");
  const [a, b] = await Promise.all([stream.pull(), stream.pull()]);
  expect(a).toBe(b);
  expect(a.type).toBe("audio");
  expect(calls.map((c) => c.body)).toEqual([
    { ...input, requestId: id },
    { ...input, requestId: id },
    { streamId: id, cursor: 0 },
    { streamId: id, cursor: 0 },
  ]);
  expect(stream.renderedSpeed).toBe(0.8);
});
test("Stop overtakes a delayed start and prevents old audio from being published", async () => {
  let release!: (value: unknown) => void;
  const calls: string[] = [];
  const stream = createNativeSpeechStream(
    async (path) => {
      calls.push(path);
      if (path.endsWith("start"))
        return new Promise((resolve) => {
          release = resolve;
        });
      return { state: "cancelled" };
    },
    input,
    { requestId: id },
  );
  const opening = stream.open();
  await stream.cancel();
  release(started);
  await expect(opening).rejects.toThrow("Speech stopped");
  await expect(stream.pull()).rejects.toThrow("Speech stopped");
  expect(calls).toEqual([
    "/voice/tts/stream/start",
    "/voice/tts/stream/cancel",
  ]);
});
test("account AbortSignal discards a delayed pull and cancels the original identity", async () => {
  let release!: (value: unknown) => void;
  let didPull!: () => void;
  const pulled = new Promise<void>((resolve) => {
    didPull = resolve;
  });
  const cancelled: object[] = [];
  const controller = new AbortController();
  const stream = createNativeSpeechStream(
    async (path, body) => {
      if (path.endsWith("start")) return started;
      if (path.endsWith("cancel")) {
        cancelled.push(body);
        return { state: "cancelled" };
      }
      return new Promise((resolve) => {
        release = resolve;
        didPull();
      });
    },
    input,
    { requestId: id, signal: controller.signal },
  );
  const pending = stream.pull();
  await pulled;
  controller.abort();
  release({ cursor: 0, frame: audio });
  await expect(pending).rejects.toThrow("Speech stopped");
  expect(cancelled).toEqual([{ requestId: id }]);
});
test("bad completion and mismatched acknowledgement cancel instead of enabling resynthesis", async () => {
  for (const bad of ["speed", "completion", "timing", "cursor"]) {
    let cancelled = 0;
    const stream = createNativeSpeechStream(
      async (path) => {
        if (path.endsWith("cancel")) {
          cancelled++;
          return {};
        }
        if (path.endsWith("start"))
          return { ...started, renderedSpeed: bad === "speed" ? 1 : 0.8 };
        return {
          cursor: bad === "cursor" ? 3 : 0,
          frame:
            bad === "completion"
              ? { type: "done", frames: 0, audioBytes: 0 }
              : bad === "timing"
                ? {
                    ...audio,
                    alignment: {
                      characters: ["a"],
                      characterStartTimesSeconds: [2],
                      characterEndTimesSeconds: [1],
                    },
                  }
                : audio,
        };
      },
      input,
      { requestId: id },
    );
    await expect(stream.pull()).rejects.toThrow();
    await expect(stream.pull()).rejects.toThrow("Speech stopped");
    expect(cancelled).toBe(1);
  }
});
test("exact totals finish once and preserve original/normalized timing without offsets", async () => {
  let cursor = 0;
  const alignment = {
    characters: ["1"],
    characterStartTimesSeconds: [0],
    characterEndTimesSeconds: [0.5],
  };
  const normalizedAlignment = {
    characters: ["one"],
    characterStartTimesSeconds: [0],
    characterEndTimesSeconds: [0.5],
  };
  const stream = createNativeSpeechStream(
    async (path) =>
      path.endsWith("start")
        ? started
        : cursor++ === 0
          ? { cursor: 0, frame: { ...audio, alignment, normalizedAlignment } }
          : { cursor: 1, frame: { type: "done", frames: 1, audioBytes: 3 } },
    input,
    { requestId: id },
  );
  expect(await stream.pull()).toEqual({
    type: "audio",
    sequence: 0,
    mimeType: "audio/mpeg",
    audio: Uint8Array.of(1, 2, 3),
    alignment,
    normalizedAlignment,
  });
  expect(await stream.pull()).toEqual({
    type: "done",
    frames: 1,
    audioBytes: 3,
  });
  await expect(stream.pull()).rejects.toThrow("complete");
});

test("expired client identity cannot dispatch a fresh synthesis after the host replay window", async () => {
  let time = 0,
    starts = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => time);
  try {
    const stream = createNativeSpeechStream(
      async (path) => {
        if (path.endsWith("start")) {
          starts++;
          throw Error("lost");
        }
        return {};
      },
      input,
      { requestId: id },
    );
    await expect(stream.open()).rejects.toThrow("lost");
    time = 600000;
    await expect(stream.open()).rejects.toThrow("expired");
    expect(starts).toBe(1);
  } finally {
    clock.mockRestore();
  }
});
