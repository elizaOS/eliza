import { describe, expect, it, vi } from "vitest";
import {
  type CloudStreamEvent,
  type CloudStreamPort,
  createCloudStreamingSpeech,
} from "./native-cloud-speech.js";

function fakePort() {
  let listener: ((event: CloudStreamEvent) => void) | undefined;
  const spoken: string[] = [];
  const port: CloudStreamPort = {
    async startCloudSpeech(input) {
      return {
        sessionId: input.sessionId,
        sampleRate: 16000,
        echoCancelled: true,
        muted: false,
      };
    },
    async stopCloudSpeech() {},
    async setCloudSpeechMuted() {},
    async speakCloudSpeech(input) {
      spoken.push(input.utteranceId);
    },
    async cancelCloudSpeech() {
      return { playedMs: 0 };
    },
    async addListener(_event, callback) {
      listener = callback;
      return { async remove() {} };
    },
  };
  return {
    port,
    spoken,
    emit: (event: CloudStreamEvent) => listener?.(event),
  };
}

async function openSession() {
  const fake = fakePort();
  let sessionId: string | undefined;
  const port: CloudStreamPort = {
    ...fake.port,
    async startCloudSpeech(input) {
      sessionId = input.sessionId;
      return fake.port.startCloudSpeech(input);
    },
  };
  const speech = createCloudStreamingSpeech(
    { environment: "test", credentialId: "c", assertCurrent() {} },
    port,
  );
  await speech.listen({
    signal: new AbortController().signal,
    onSpeechStart() {},
    onSpeechEnd() {},
    onSegment() {},
    onEnd() {},
  });
  return { ...fake, speech, sessionId: () => sessionId };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("native speech capture recovery", () => {
  it("reopens a missing lease and retries only the sentence that never became audible", async () => {
    const fake = fakePort();
    const start = vi.fn(fake.port.startCloudSpeech);
    const stop = vi.fn(fake.port.stopCloudSpeech);
    const speak = vi.fn(fake.port.speakCloudSpeech);
    const onEnd = vi.fn();
    const onStarted = vi.fn();
    const speech = createCloudStreamingSpeech(
      { environment: "test", credentialId: "c", assertCurrent() {} },
      { ...fake.port, startCloudSpeech: start, stopCloudSpeech: stop, speakCloudSpeech: speak },
    );
    const capture = await speech.listen({
      signal: new AbortController().signal,
      onSpeechStart() {},
      onSpeechEnd() {},
      onSegment() {},
      onEnd,
    });
    await capture.close();
    const pending = speech.speak("The named note is open.", new AbortController().signal, onStarted);
    await flush();
    const original = speak.mock.calls[0][0];
    fake.emit({ sessionId: original.sessionId, type: "error", code: "expired" });
    await flush();
    const next = start.mock.calls[1][0];
    expect(stop).toHaveBeenCalledWith({ sessionId: original.sessionId });
    expect(next).toMatchObject({ muted: true, credentialId: "c" });
    expect(next.sessionId).not.toBe(original.sessionId);
    expect(speak.mock.calls[1][0]).toEqual({ ...original, sessionId: next.sessionId });
    fake.emit({ ...original, type: "audio-start" });
    expect(onStarted).not.toHaveBeenCalled();
    fake.emit({ ...original, sessionId: next.sessionId, type: "audio-start" });
    fake.emit({ ...original, sessionId: next.sessionId, type: "audio-end" });
    await pending;
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
    await speech.stop();
  });

  it("joins a pending transport stop and does not reopen after the owner stops", async () => {
    vi.useFakeTimers();
    const fake = fakePort();
    const start = vi.fn(fake.port.startCloudSpeech);
    let acknowledgeStop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      acknowledgeStop = resolve;
    });
    const stop = vi.fn(async () => stopped);
    const speech = createCloudStreamingSpeech(
      { environment: "test", credentialId: "c", assertCurrent() {} },
      { ...fake.port, startCloudSpeech: start, stopCloudSpeech: stop },
    );
    try {
      const capture = await speech.listen({
        signal: new AbortController().signal,
        onSpeechStart() {},
        onSpeechEnd() {},
        onSegment() {},
        onEnd() {},
      });
      fake.emit({
        sessionId: start.mock.calls[0][0].sessionId,
        type: "speech-start",
      });
      const closing = expect(capture.close()).rejects.toMatchObject({
        name: "AbortError",
      });
      await vi.advanceTimersByTimeAsync(2500);
      const ending = speech.stop();
      acknowledgeStop();
      await ending;
      await closing;
      expect(stop).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      acknowledgeStop();
      await speech.stop();
      vi.useRealTimers();
    }
  });

  it("rearms Talk after a speech start arrived while the reply was playing", async () => {
    vi.useFakeTimers();
    const fake = fakePort();
    const start = vi.fn(fake.port.startCloudSpeech);
    const mute = vi.fn(fake.port.setCloudSpeechMuted);
    const onSegment = vi.fn();
    const speech = createCloudStreamingSpeech(
      { environment: "test", credentialId: "c", assertCurrent() {} },
      { ...fake.port, startCloudSpeech: start, setCloudSpeechMuted: mute },
    );
    const handlers = {
      signal: new AbortController().signal,
      onSpeechStart() {},
      onSpeechEnd() {},
      onSegment,
      onEnd() {},
    };
    try {
      const first = await speech.listen(handlers);
      const oldId = start.mock.calls[0][0].sessionId;
      await first.close();
      fake.emit({ sessionId: oldId, type: "speech-start" });
      const next = speech.listen(handlers);
      await vi.advanceTimersByTimeAsync(2500);
      await next;
      const newId = start.mock.calls[1][0].sessionId;
      expect(mute.mock.calls.at(-1)?.[0]).toEqual({
        sessionId: newId,
        muted: false,
      });
      fake.emit({ sessionId: oldId, type: "speech-end", text: "late" });
      fake.emit({ sessionId: newId, type: "speech-start" });
      fake.emit({ sessionId: newId, type: "speech-end", text: "next request" });
      expect(onSegment.mock.calls).toEqual([["next request"]]);
    } finally {
      await speech.stop();
      vi.useRealTimers();
    }
  });

  it("replaces the muted transport after a missing final and ignores the old transcript", async () => {
    vi.useFakeTimers();
    const fake = fakePort();
    const history: string[] = [];
    const segments: Array<string | null> = [];
    const start = vi.fn(fake.port.startCloudSpeech);
    const close = vi.fn(async () => {
      history.push("old transport stopped");
    });
    const setMute = vi.fn(fake.port.setCloudSpeechMuted);
    const speech = createCloudStreamingSpeech(
      { environment: "test", credentialId: "c", assertCurrent() {} },
      {
        ...fake.port,
        startCloudSpeech: start,
        stopCloudSpeech: close,
        setCloudSpeechMuted: setMute,
      },
    );
    const handlers = {
      signal: new AbortController().signal,
      onSpeechStart() {},
      onSpeechEnd() {},
      onSegment: (text: string | null) => segments.push(text),
      onEnd: vi.fn(),
    };
    try {
      const capture = await speech.listen(handlers);
      const oldId = start.mock.calls[0][0].sessionId;
      fake.emit({ sessionId: oldId, type: "speech-start" });
      const paused = capture.close();
      await vi.advanceTimersByTimeAsync(2500);
      await paused;
      const replacement = start.mock.calls[1][0];
      expect(history).toEqual(["old transport stopped"]);
      expect(close).toHaveBeenCalledWith({ sessionId: oldId });
      expect(replacement.sessionId).not.toBe(oldId);
      expect(replacement.muted).toBe(true);
      expect(setMute.mock.calls.map(([value]) => value.muted)).toEqual([
        false,
        true,
      ]);
      expect(segments).toEqual([null]);
      await speech.listen(handlers);
      fake.emit({ sessionId: oldId, type: "speech-end", text: "stale" });
      fake.emit({ sessionId: replacement.sessionId, type: "speech-start" });
      fake.emit({
        sessionId: replacement.sessionId,
        type: "speech-end",
        text: "fresh",
      });
      expect(segments).toEqual([null, "fresh"]);
      expect(handlers.onEnd).not.toHaveBeenCalled();
    } finally {
      await speech.stop();
      vi.useRealTimers();
    }
  });

  it("never opens another transport when the microphone mute is unconfirmed", async () => {
    vi.useFakeTimers();
    const fake = fakePort();
    const start = vi.fn(fake.port.startCloudSpeech);
    const speech = createCloudStreamingSpeech(
      { environment: "test", credentialId: "c", assertCurrent() {} },
      {
        ...fake.port,
        startCloudSpeech: start,
        async setCloudSpeechMuted({ muted }) {
          if (muted) await new Promise<void>(() => {});
        },
      },
    );
    try {
      const capture = await speech.listen({
        signal: new AbortController().signal,
        onSpeechStart() {},
        onSpeechEnd() {},
        onSegment() {},
        onEnd() {},
      });
      const result = expect(capture.close()).rejects.toThrow(
        "did not confirm the mute",
      );
      await vi.advanceTimersByTimeAsync(2500);
      await result;
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      await speech.stop();
      vi.useRealTimers();
    }
  });
});

describe("native cloud speech utterance end", () => {
  it("resolves a spoken utterance on audio-end", async () => {
    const { speech, spoken, emit, sessionId } = await openSession();
    const done = speech.speak("hello", new AbortController().signal, () => {});
    await flush();
    const utteranceId = spoken[0];
    emit({ sessionId: sessionId(), type: "audio-start", utteranceId });
    emit({
      sessionId: sessionId(),
      type: "audio-end",
      utteranceId,
      silent: false,
      playedMs: 420,
    });
    await expect(done).resolves.toBeUndefined();
  });

  it("rejects with the reason when a transient focus loss interrupts the utterance", async () => {
    const { speech, spoken, emit, sessionId } = await openSession();
    const done = speech.speak("hello", new AbortController().signal, () => {});
    await flush();
    const utteranceId = spoken[0];
    emit({ sessionId: sessionId(), type: "audio-start", utteranceId });
    emit({
      sessionId: sessionId(),
      type: "audio-end",
      utteranceId,
      silent: false,
      playedMs: 120,
      interrupted: "audio-focus-lost",
    });
    await expect(done).rejects.toMatchObject({ code: "audio-focus-lost" });
    // The session stays open: a focus pause is not a session failure.
    const next = speech.speak("again", new AbortController().signal, () => {});
    await flush();
    emit({
      sessionId: sessionId(),
      type: "audio-start",
      utteranceId: spoken[1],
    });
    emit({ sessionId: sessionId(), type: "audio-end", utteranceId: spoken[1] });
    await expect(next).resolves.toBeUndefined();
  });

  it("ignores focus pause and resume events", async () => {
    const { speech, spoken, emit, sessionId } = await openSession();
    emit({ sessionId: sessionId(), type: "focus-paused" });
    emit({ sessionId: sessionId(), type: "focus-resumed" });
    const done = speech.speak("hello", new AbortController().signal, () => {});
    await flush();
    emit({
      sessionId: sessionId(),
      type: "audio-start",
      utteranceId: spoken[0],
    });
    emit({ sessionId: sessionId(), type: "audio-end", utteranceId: spoken[0] });
    await expect(done).resolves.toBeUndefined();
  });
});
