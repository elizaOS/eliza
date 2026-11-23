import { describe, expect, it } from "vitest";
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
