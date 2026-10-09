/** Closed injected-host control contract; fake media/providers, not physical audio acceptance. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BatchVoiceCapture,
  BatchVoiceConversation,
  type BatchVoiceOptions,
  type BatchVoicePorts,
  type BatchVoiceReply,
} from "../batch-conversation";
import {
  createVoiceActivityDetector,
  DEFAULT_VOICE_ACTIVITY,
} from "../voice-activity";

const held = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const settle = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
function fixture(options: BatchVoiceOptions = {}) {
  let valid = true,
    checks: (() => void) | undefined,
    stateChanged: ((phase: string) => void) | undefined,
    stops = 0,
    transcribes = 0;
  const captures: {
      input: Parameters<BatchVoicePorts<string>["capture"]>[0];
      handle: BatchVoiceCapture<string>;
      cancelled: number;
    }[] = [],
    sends: Parameters<BatchVoicePorts<string>["send"]>[0][] = [],
    speeches: Parameters<BatchVoicePorts<string>["speak"]>[0][] = [],
    states: string[] = [],
    transcripts = ["What is the time?"];
  let acquire:
      | ((
          handle: BatchVoiceCapture<string>,
        ) => Promise<BatchVoiceCapture<string>>)
      | undefined,
    transcribe: BatchVoicePorts<string>["transcribe"] = async () =>
      transcripts.shift() ?? "Another question?",
    send: BatchVoicePorts<string>["send"] = async (input) => ({
      requestId: input.turnId,
      conversationId: "room",
      userMessageId: `user-${input.turnId}`,
      assistantMessageId: `reply-${input.turnId}`,
      text: "Assistant answer.",
      complete: true,
    }),
    playback = held<void>();
  let delayedStart = false,
    heldSpeechCleanup = false;
  const ports: BatchVoicePorts<string> = {
    conversationId: "room",
    assertCurrent() {
      if (!valid) throw Error("Binding changed");
      checks?.();
    },
    async capture(input) {
      const row = {
        input,
        cancelled: 0,
        handle: {
          stop: async () => {
            stops++;
            return `clip-${captures.indexOf(row)}`;
          },
          cancel: async () => {
            row.cancelled++;
          },
        },
      };
      captures.push(row);
      return acquire ? acquire(row.handle) : row.handle;
    },
    transcribe: (clip, signal) => {
      transcribes++;
      return transcribe(clip, signal);
    },
    send: (input) => {
      sends.push(input);
      return send(input);
    },
    speak: (input) => {
      speeches.push(input);
      if (!delayedStart) input.onStarted();
      const owned = playback;
      input.signal.addEventListener(
        "abort",
        () => {
          if (!heldSpeechCleanup) owned.resolve();
        },
        { once: true },
      );
      return owned.promise;
    },
    onState: (state) => {
      states.push(state.phase);
      stateChanged?.(state.phase);
    },
  };
  const controller = new BatchVoiceConversation(ports, options);
  return {
    controller,
    holdSpeechRetirement: () => {
      heldSpeechCleanup = true;
    },
    delayPlaybackStart: () => {
      delayedStart = true;
    },
    captures,
    sends,
    speeches,
    states,
    transcripts,
    onCheck: (fn: () => void) => {
      checks = fn;
    },
    onState: (fn: (phase: string) => void) => {
      stateChanged = fn;
    },
    stopped: () => stops,
    transcribed: () => transcribes,
    invalidate: () => {
      valid = false;
    },
    acquire: (fn: typeof acquire) => {
      acquire = fn;
    },
    transcribe: (fn: BatchVoicePorts<string>["transcribe"]) => {
      transcribe = fn;
    },
    send: (fn: BatchVoicePorts<string>["send"]) => {
      send = fn;
    },
    finishPlayback: () => {
      playback.resolve();
      playback = held<void>();
    },
  };
}
async function utterance(f: ReturnType<typeof fixture>) {
  await vi.advanceTimersByTimeAsync(300);
  f.captures[f.captures.length - 1].input.onActivity({ peak: 0.1 });
  await vi.advanceTimersByTimeAsync(200);
  f.captures[f.captures.length - 1].input.onActivity({ peak: 0.1 });
  await vi.advanceTimersByTimeAsync(700);
  f.captures[f.captures.length - 1].input.onActivity({ peak: 0 });
  await settle();
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("injected batch conversation", () => {
  it("sends one VOICE_DM turn, waits for matching completed playback, then listens again", async () => {
    const f = fixture();
    await f.controller.start();
    await utterance(f);
    expect(f.sends).toHaveLength(1);
    expect(f.speeches).toHaveLength(1);
    expect(f.speeches[0].turnId).toBe(f.sends[0].turnId);
    expect(f.speeches[0].replyId).toBe(`reply-${f.sends[0].turnId}`);
    expect(f.captures).toHaveLength(1);
    expect(f.controller.getSnapshot().phase).toBe("speaking");
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.captures).toHaveLength(1);
    f.finishPlayback();
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    expect(f.captures).toHaveLength(2);
    await f.controller.stop();
  });
  it("joins a held unfinished turn with the next final before sending", async () => {
    const f = fixture();
    f.transcripts.splice(0, 1, "Schedule a meeting with", "Bob tomorrow.");
    await f.controller.start();
    await utterance(f);
    expect(f.sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    await utterance(f);
    expect(f.sends.map((s) => s.text)).toEqual([
      "Schedule a meeting with Bob tomorrow.",
    ]);
    await f.controller.stop();
  });
  it("quiet captures and echoed or disfluent transcripts never dispatch another turn", async () => {
    const f = fixture();
    await f.controller.start();
    f.captures[0].input.onEnd();
    await settle();
    expect(f.sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    await utterance(f);
    f.finishPlayback();
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    f.transcripts.push("Assistant answer.");
    await utterance(f);
    expect(f.sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    f.transcripts.push("um");
    await utterance(f);
    expect(f.sends).toHaveLength(1);
    await f.controller.stop();
  });
  for (const phase of ["transcribe", "send", "speak"] as const)
    it(`stop during ${phase} refuses late completion and rearm`, async () => {
      const f = fixture(),
        pending = held<unknown>();
      if (phase === "transcribe")
        f.transcribe(() => pending.promise as Promise<string>);
      if (phase === "send")
        f.send(() => pending.promise as Promise<BatchVoiceReply>);
      await f.controller.start();
      await utterance(f);
      await f.controller.stop();
      if (phase === "transcribe") pending.resolve("Late question?");
      if (phase === "send")
        pending.resolve({
          requestId: f.sends[0].turnId,
          conversationId: "room",
          userMessageId: "u",
          assistantMessageId: "a",
          text: "Late reply",
          complete: true,
        });
      if (phase === "speak") f.finishPlayback();
      await settle();
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.captures).toHaveLength(1);
      expect(f.speeches).toHaveLength(phase === "speak" ? 1 : 0);
      expect(f.controller.getSnapshot().phase).toBe("idle");
    });
  it("a late microphone lease drains before a replacement can acquire", async () => {
    const f = fixture(),
      pending = held<BatchVoiceCapture<string>>();
    f.acquire(() => pending.promise);
    const starting = f.controller.start().catch(() => {});
    await settle();
    const stopping = f.controller.stop();
    f.acquire(undefined);
    const replacement = f.controller.start();
    await settle();
    expect(f.captures).toHaveLength(1);
    pending.resolve(f.captures[0].handle);
    await stopping;
    await starting;
    await replacement;
    expect(f.captures[0].cancelled).toBe(1);
    expect(f.captures).toHaveLength(2);
    await f.controller.stop();
  });
  for (const mismatch of [
    "request",
    "conversation",
    "interrupted",
    "incomplete",
    "missing-message",
  ] as const)
    it(`refuses ${mismatch} reply without speech or rearm`, async () => {
      const f = fixture();
      f.send(async (input) => ({
        requestId: mismatch === "request" ? "old-request" : input.turnId,
        conversationId: mismatch === "conversation" ? "old-room" : "room",
        userMessageId: "u",
        assistantMessageId: mismatch === "missing-message" ? "" : "a",
        text: "Unconfirmed reply",
        complete: mismatch !== "incomplete",
        interrupted: mismatch === "interrupted",
      }));
      await f.controller.start();
      await utterance(f);
      await settle();
      expect(f.speeches).toHaveLength(0);
      expect(f.controller.getSnapshot().phase).toBe("error");
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.captures).toHaveLength(1);
    });
  for (const phase of ["listening", "transcribe", "send", "speak"] as const)
    it(`changed host binding during ${phase} retires the session`, async () => {
      const f = fixture(),
        pending = held<unknown>();
      if (phase === "transcribe")
        f.transcribe(() => pending.promise as Promise<string>);
      if (phase === "send")
        f.send(() => pending.promise as Promise<BatchVoiceReply>);
      await f.controller.start();
      if (phase !== "listening") await utterance(f);
      f.invalidate();
      f.controller.recheck();
      await settle();
      if (phase === "transcribe") pending.resolve("Late words");
      if (phase === "send") pending.resolve({});
      if (phase === "speak") f.finishPlayback();
      await settle();
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.captures).toHaveLength(1);
      expect(f.controller.getSnapshot().phase).toBe("idle");
    });
  it("discards a held semantic timer when the user stops", async () => {
    const f = fixture();
    f.transcripts[0] = "Schedule a meeting with";
    await f.controller.start();
    await utterance(f);
    await f.controller.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.sends).toHaveLength(0);
    expect(f.captures).toHaveLength(1);
  });
  for (const changed of ["stop", "account"] as const)
    it(`interposed ${changed} after awaited microphone admission cannot publish listening`, async () => {
      const f = fixture();
      let scheduled = false;
      f.onCheck(() => {
        if (
          !scheduled &&
          f.captures.length === 1 &&
          f.controller.getSnapshot().phase === "starting"
        ) {
          scheduled = true;
          void Promise.resolve().then(() => {
            if (changed === "stop") void f.controller.stop();
            else f.invalidate();
          });
        }
      });
      await f.controller.start().catch(() => {});
      await settle();
      expect(scheduled).toBe(true);
      expect(f.states).not.toContain("listening");
      expect(f.transcribed()).toBe(0);
      expect(f.sends).toHaveLength(0);
      expect(f.captures[0].cancelled).toBe(1);
    });
  it("interposed Stop after awaited recording stop cannot invoke transcription", async () => {
    const f = fixture();
    await f.controller.start();
    let scheduled = false;
    f.onCheck(() => {
      if (!scheduled && f.stopped() === 1) {
        scheduled = true;
        void Promise.resolve().then(() => f.controller.stop());
      }
    });
    await utterance(f);
    await settle();
    expect(scheduled).toBe(true);
    expect(f.transcribed()).toBe(0);
    expect(f.sends).toHaveLength(0);
    expect(f.speeches).toHaveLength(0);
  });
  it("a state observer can Stop before the capture stop port is invoked", async () => {
    const f = fixture();
    await f.controller.start();
    f.onState((phase) => {
      if (phase === "transcribing") void f.controller.stop();
    });
    await utterance(f);
    expect(f.stopped()).toBe(0);
    expect(f.transcribed()).toBe(0);
    expect(f.sends).toHaveLength(0);
  });
  it("does not replay a completed assistant message ID for a later utterance", async () => {
    const f = fixture();
    f.send(async (input) => ({
      requestId: input.turnId,
      conversationId: "room",
      userMessageId: `u-${input.turnId}`,
      assistantMessageId: "same-reply",
      text: "First answer.",
      complete: true,
    }));
    await f.controller.start();
    await utterance(f);
    f.finishPlayback();
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    await utterance(f);
    expect(f.speeches).toHaveLength(1);
    expect(f.controller.getSnapshot().phase).toBe("error");
  });
  it("a delayed playback-start event after account change retires without throwing", async () => {
    const f = fixture();
    f.delayPlaybackStart();
    await f.controller.start();
    await utterance(f);
    expect(f.controller.getSnapshot().phase).toBe("preparing-speech");
    f.invalidate();
    expect(() => f.speeches[0].onStarted()).not.toThrow();
    await settle();
    f.finishPlayback();
    await settle();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.states).not.toContain("speaking");
    expect(f.controller.getSnapshot().phase).toBe("idle");
    expect(f.captures).toHaveLength(1);
  });
  it("microphone grace starts after delayed permission acquisition", async () => {
    const f = fixture(),
      pending = held<BatchVoiceCapture<string>>();
    f.acquire(() => pending.promise);
    const started = f.controller.start();
    await settle();
    await vi.advanceTimersByTimeAsync(10000);
    pending.resolve(f.captures[0].handle);
    await started;
    await vi.advanceTimersByTimeAsync(100);
    f.captures[0].input.onActivity({ peak: 0.1 });
    await vi.advanceTimersByTimeAsync(200);
    f.captures[0].input.onActivity({ peak: 0.1 });
    f.captures[0].input.onEnd();
    await settle();
    expect(f.transcribed()).toBe(0);
    expect(f.sends).toHaveLength(0);
    await f.controller.stop();
  });
  it("a playback completion without actual playback admission cannot rearm", async () => {
    const f = fixture();
    f.delayPlaybackStart();
    await f.controller.start();
    await utterance(f);
    f.finishPlayback();
    await settle();
    expect(f.controller.getSnapshot().phase).toBe("error");
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.captures).toHaveLength(1);
  });
  it("honors the host echo activity gate without treating quiet peak-only input as speech", async () => {
    const f = fixture({ activity: { isTtsEchoGateActive: () => true } });
    await f.controller.start();
    await vi.advanceTimersByTimeAsync(300);
    f.captures[0].input.onActivity({ peak: 0.02 });
    await vi.advanceTimersByTimeAsync(200);
    f.captures[0].input.onActivity({ peak: 0.02 });
    await vi.advanceTimersByTimeAsync(700);
    f.captures[0].input.onActivity({ peak: 0 });
    f.captures[0].input.onEnd();
    await settle();
    expect(f.transcribed()).toBe(0);
    expect(f.sends).toHaveLength(0);
    await f.controller.stop();
  });
  it("replacement capture waits for the old owned playback abort cleanup", async () => {
    const f = fixture();
    f.holdSpeechRetirement();
    await f.controller.start();
    await utterance(f);
    const stopped = f.controller.stop(),
      replacement = f.controller.start();
    await settle();
    expect(f.captures).toHaveLength(1);
    f.finishPlayback();
    await stopped;
    await replacement;
    expect(f.captures).toHaveLength(2);
    await f.controller.stop();
  });
  for (const phase of ["before speech", "during speech"] as const)
    it(`owned microphone failure ${phase} retires instead of silently rearming`, async () => {
      const f = fixture();
      await f.controller.start();
      if (phase === "during speech") {
        await vi.advanceTimersByTimeAsync(300);
        f.captures[0].input.onActivity({ peak: 0.1 });
        await vi.advanceTimersByTimeAsync(200);
        f.captures[0].input.onActivity({ peak: 0.1 });
      }
      f.captures[0].input.onEnd(Error("Metrics unavailable"));
      await settle();
      expect(f.controller.getSnapshot().phase).toBe("error");
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.captures).toHaveLength(1);
      expect(f.transcribed()).toBe(0);
      expect(f.sends).toHaveLength(0);
    });
  it("canonical echo cooldown survives recreating a coordinator after Stop", async () => {
    await vi.advanceTimersByTimeAsync(1000000);
    const first = fixture();
    await first.controller.start();
    await utterance(first);
    await first.controller.stop();
    const next = fixture();
    await next.controller.start();
    await vi.advanceTimersByTimeAsync(300);
    next.captures[0].input.onActivity({ peak: 0.02 });
    await vi.advanceTimersByTimeAsync(200);
    next.captures[0].input.onActivity({ peak: 0.02 });
    await vi.advanceTimersByTimeAsync(700);
    next.captures[0].input.onActivity({ peak: 0 });
    next.captures[0].input.onEnd();
    await settle();
    expect(next.transcribed()).toBe(0);
    expect(next.sends).toHaveLength(0);
    await next.controller.stop();
  });
  it("does not speak hidden reasoning from the confirmed assistant reply", async () => {
    const f = fixture();
    f.send(async (input) => ({
      requestId: input.turnId,
      conversationId: "room",
      userMessageId: "u",
      assistantMessageId: "a",
      text: "<think>Private reasoning</think> Visible answer.",
      complete: true,
    }));
    await f.controller.start();
    await utterance(f);
    expect(f.speeches[0].text).toBe("Visible answer.");
    await f.controller.stop();
  });
});
describe("canonical activity with native peak-only observations", () => {
  it("keeps grace/minimum speech and silence policy without fabricating RMS", () => {
    let now = 0;
    const detector = createVoiceActivityDetector({}, 0, () => now);
    now = 100;
    expect(detector({ peak: 0.1 }).shouldBuffer).toBe(false);
    now = 300;
    detector({ peak: 0.1 });
    now = 400;
    detector({ peak: 0 });
    expect(detector.hasSpeech).toBe(false);
    now = 500;
    detector({ peak: 0.1 });
    expect(detector.hasSpeech).toBe(true);
    now = 500 + DEFAULT_VOICE_ACTIVITY.silenceMs;
    expect(detector({ peak: 0 }).shouldStop).toBe(true);
  });
  it("raises peak thresholds during echo cooldown and bounds long speech", () => {
    let now = 300;
    const detector = createVoiceActivityDetector(
      { isTtsEchoGateActive: () => true, maxSpeechMs: 1000 },
      0,
      () => now,
    );
    expect(detector({ peak: 0.02 }).shouldBuffer).toBe(false);
    expect(detector({ peak: 0.1 }).shouldBuffer).toBe(true);
    now = 1300;
    expect(detector({ peak: 0.1 }).shouldStop).toBe(true);
  });
});
