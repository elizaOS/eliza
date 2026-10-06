import { expect, test } from "bun:test";
import { createTimedSpeechStream } from "./timed-speech-stream";

const timing = {
  characters: ["H", "i"],
  characterStartTimesSeconds: [0, 0.1],
  characterEndTimesSeconds: [0.1, 0.3],
};
const frame = {
  audioBase64: "AQID",
  alignment: timing,
  normalizedAlignment: { ...timing, characters: ["h", "i"] },
  privateProviderData: "omit",
};
async function* source(values: unknown[]) {
  yield* values;
}

test("streams on demand and preserves both alignments with a completion record", async () => {
  let reads = 0;
  async function* chunks() {
    reads++;
    yield frame;
    reads++;
    yield { audioBase64: "BA==" };
  }
  const stream = createTimedSpeechStream(chunks(), () => {});
  expect(reads).toBe(0);
  const reader = stream.getReader();
  const first = JSON.parse(new TextDecoder().decode((await reader.read()).value));
  expect(reads).toBe(1);
  expect(first).toEqual({
    type: "audio",
    sequence: 0,
    audioBase64: "AQID",
    mimeType: "audio/mpeg",
    alignment: timing,
    normalizedAlignment: frame.normalizedAlignment,
  });
  const second = JSON.parse(new TextDecoder().decode((await reader.read()).value));
  expect(second.sequence).toBe(1);
  expect(second.alignment).toBeNull();
  expect(JSON.parse(new TextDecoder().decode((await reader.read()).value))).toEqual({
    type: "done",
    frames: 2,
    audioBytes: 4,
  });
  expect((await reader.read()).done).toBe(true);
});

test("cancelling returns the iterator and aborts the provider without draining it", async () => {
  let returned = false,
    aborted = false,
    count = 0;
  async function* chunks() {
    try {
      count++;
      yield frame;
      count++;
      yield frame;
    } finally {
      returned = true;
    }
  }
  const reader = createTimedSpeechStream(chunks(), () => {
    aborted = true;
  }).getReader();
  await reader.read();
  await reader.cancel();
  expect(aborted).toBe(true);
  expect(returned).toBe(true);
  expect(count).toBe(1);
});

test("rejects invalid timing and framing without exposing provider data", async () => {
  for (const value of [
    null,
    { audioBase64: "bad!" },
    { audioBase64: "A===" },
    { ...frame, alignment: { ...timing, characters: ["H"] } },
    { ...frame, alignment: { ...timing, characterStartTimesSeconds: [0.2, 0.1] } },
    { ...frame, alignment: { ...timing, characterEndTimesSeconds: [0.1, NaN] } },
    { ...frame, alignment: { ...timing, characterEndTimesSeconds: [0.1, 4000] } },
    { ...frame, alignment: { ...timing, characterStartTimesSeconds: [-1, 0.1] } },
  ]) {
    let aborted = false;
    await expect(
      new Response(
        createTimedSpeechStream(source([value]), () => {
          aborted = true;
        }),
      ).text(),
    ).rejects.toThrow("Invalid timed speech response");
    expect(aborted).toBe(true);
  }
  async function* broken() {
    yield frame;
    throw new Error("private-provider-text");
  }
  await expect(new Response(createTimedSpeechStream(broken(), () => {})).text()).rejects.toThrow(
    "Invalid timed speech response",
  );
  await expect(new Response(createTimedSpeechStream(source([]), () => {})).text()).rejects.toThrow(
    "Invalid timed speech response",
  );
});

test("bounds audio, alignment and frame totals rather than silently truncating", async () => {
  const audio = btoa("a".repeat(1024 * 1024));
  await expect(
    new Response(
      createTimedSpeechStream(
        source(Array.from({ length: 9 }, () => ({ audioBase64: audio }))),
        () => {},
      ),
    ).text(),
  ).rejects.toThrow("Invalid timed speech response");
  const big = {
    characters: Array(25001).fill("a"),
    characterStartTimesSeconds: Array(25001).fill(0),
    characterEndTimesSeconds: Array(25001).fill(1),
  };
  await expect(
    new Response(
      createTimedSpeechStream(
        source([{ audioBase64: "AQID", alignment: big, normalizedAlignment: big }]),
        () => {},
      ),
    ).text(),
  ).rejects.toThrow("Invalid timed speech response");
  await expect(
    new Response(
      createTimedSpeechStream(
        source(Array.from({ length: 2049 }, () => ({ audioBase64: "AQID" }))),
        () => {},
      ),
    ).text(),
  ).rejects.toThrow("Invalid timed speech response");
});

test("cancellation during a pending read discards late frames", async () => {
  let resolveRead: ((value: IteratorResult<unknown>) => void) | undefined;
  let returned = false;
  const source: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
        return: async () => {
          returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const reader = createTimedSpeechStream(source, () =>
    resolveRead?.({ done: false, value: frame }),
  ).getReader();
  const pending = reader.read();
  await Promise.resolve();
  await reader.cancel();
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(returned).toBe(true);
});

test("cleanup errors cannot disclose provider content", async () => {
  const source: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: false, value: frame }),
        return: async () => {
          throw new Error("private provider content");
        },
      };
    },
  };
  const reader = createTimedSpeechStream(source, () => {}).getReader();
  await reader.read();
  await expect(reader.cancel()).rejects.toThrow("Invalid timed speech response");
});
