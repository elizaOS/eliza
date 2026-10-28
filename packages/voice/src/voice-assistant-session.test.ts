import { describe, expect, it } from "vitest";
import {
  ASSISTANT_TIMING_DEFAULTS,
  type AssistantCapture,
  type AssistantClock,
  type AssistantHeard,
  type AssistantListenHandlers,
  type AssistantPorts,
  type AssistantReply,
  type AssistantState,
  type EndpointDecision,
  type EndpointRecord,
  type EndpointResult,
  splitSpokenSentences,
  VoiceAssistantSession,
} from "./voice-assistant-session";

// Fake clock, capture, agent and speaker. These are controller contracts, not microphone,
// recognition, playback or latency evidence.
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing item ${index}`);
  return item;
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: AssistantClock & { advance(ms: number): Promise<void> } = {
    now: () => now,
    setTimer: (callback, ms) => {
      const handle = ++id;
      timers.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
        await flush();
      }
      now = end;
      await flush();
    },
  };
  return clock;
}

type Send = { turnId: string; text: string };
type Reply = {
  input: Parameters<AssistantPorts["send"]>[0];
  reply: Deferred<AssistantReply>;
};
type Speech = {
  input: Parameters<AssistantPorts["speak"]>[0];
  done: Deferred<void>;
};

function harness(
  options: {
    endpoint?: AssistantPorts["endpoint"];
    shouldRespond?: AssistantPorts["shouldRespond"];
    fullDuplex?: boolean;
    holdOpen?: Deferred<void>;
  } = {},
) {
  const clock = fakeClock();
  const log = {
    sends: [] as Send[],
    heard: [] as AssistantHeard[],
    states: [] as AssistantState[],
    turns: [] as [string, string][],
    endpoints: [] as EndpointRecord[],
    captures: 0,
    cancelled: 0,
    closed: 0,
  };
  let mic: AssistantListenHandlers | undefined;
  let current = true;
  const replies: Reply[] = [];
  const speeches: Speech[] = [];
  const ports: AssistantPorts = {
    conversationId: "room-1",
    assertCurrent: () => {
      if (!current) throw new DOMException("binding changed", "AbortError");
    },
    listen: async (handlers) => {
      log.captures++;
      mic = handlers;
      if (options.holdOpen) await options.holdOpen.promise;
      return {
        fullDuplex: options.fullDuplex ?? true,
        close: async () => {
          log.closed++;
        },
        cancel: () => {
          log.cancelled++;
        },
      };
    },
    ...(options.shouldRespond ? { shouldRespond: options.shouldRespond } : {}),
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    send: (input) => {
      log.sends.push({ turnId: input.turnId, text: input.text });
      const reply = deferred<AssistantReply>();
      replies.push({ input, reply });
      input.signal.addEventListener(
        "abort",
        () => reply.reject(new DOMException("cancelled", "AbortError")),
        { once: true },
      );
      return reply.promise;
    },
    speak: (input) => {
      const done = deferred<void>();
      speeches.push({ input, done });
      input.signal.addEventListener(
        "abort",
        () => done.reject(new DOMException("stopped", "AbortError")),
        { once: true },
      );
      return done.promise;
    },
    onHeard: (value) => log.heard.push(value),
    onState: (value) => log.states.push(value),
    onTurn: (event, turnId, detail) => {
      log.turns.push([event, turnId]);
      if (detail) log.endpoints.push(detail.endpoint);
    },
  };
  const session = new VoiceAssistantSession(ports, { clock });
  const answer = (
    index: number,
    text: string,
    extra: Partial<AssistantReply> = {},
  ) => {
    const { input, reply } = at(replies, index);
    reply.resolve({
      requestId: input.turnId,
      conversationId: "room-1",
      userMessageId: `u-${index}`,
      assistantMessageId: `a-${index}`,
      text,
      complete: true,
      ...extra,
    });
  };
  const microphone = () => {
    if (!mic) throw new Error("capture not open");
    return mic;
  };
  return {
    clock,
    log,
    session,
    replies,
    speeches,
    answer,
    mic: microphone,
    setCurrent(value: boolean) {
      current = value;
    },
    async say(text: string, durationMs = 400) {
      microphone().onSpeechStart(clock.now());
      await flush();
      await clock.advance(durationMs);
      microphone().onSpeechEnd(clock.now());
      await flush();
      microphone().onSegment(text);
      await flush();
    },
    phase: () => session.getSnapshot().phase,
  };
}

const { shortGapMs, longGapMs, endpointDeadlineMs, bargeInConfirmMs } =
  ASSISTANT_TIMING_DEFAULTS;

describe("VoiceAssistantSession endpointing", () => {
  it("submits once after the long gap; resumed speech before it continues the same turn", async () => {
    const h = harness();
    await h.session.start();
    expect(h.phase()).toBe("listening");
    await h.say("remind me to call");
    await h.clock.advance(longGapMs - 100);
    expect(h.log.sends).toHaveLength(0);
    await h.say("Sam at five");
    await h.clock.advance(longGapMs - 1);
    expect(h.log.sends).toHaveLength(0);
    await h.clock.advance(1);
    expect(h.log.sends.map((send) => send.text)).toEqual([
      "remind me to call Sam at five",
    ]);
    expect(h.phase()).toBe("thinking");
  });

  it("finished submits at the short gap; slow or failing detectors never block the long gap; speech wins a racing decision", async () => {
    const finished = harness({ endpoint: async () => "finished" });
    await finished.session.start();
    await finished.say("what is the weather");
    await finished.clock.advance(shortGapMs);
    expect(finished.log.sends).toHaveLength(1);

    const never = harness({ endpoint: () => new Promise(() => {}) });
    await never.session.start();
    await never.say("what is the weather");
    await never.clock.advance(shortGapMs + endpointDeadlineMs);
    expect(never.log.sends).toHaveLength(0);
    await never.clock.advance(longGapMs);
    expect(never.log.sends).toHaveLength(1);

    const failing = harness({
      endpoint: async () => {
        throw Error("model unavailable");
      },
    });
    await failing.session.start();
    await failing.say("hello there");
    await failing.clock.advance(longGapMs);
    expect(failing.log.sends).toHaveLength(1);

    const decision = deferred<EndpointDecision>();
    const racing = harness({ endpoint: () => decision.promise });
    await racing.session.start();
    await racing.say("turn on the");
    await racing.clock.advance(shortGapMs);
    racing.mic().onSpeechStart(racing.clock.now());
    await flush();
    decision.resolve("finished");
    await flush();
    expect(racing.log.sends).toHaveLength(0);
    await racing.clock.advance(300);
    racing.mic().onSpeechEnd(racing.clock.now());
    racing.mic().onSegment("kitchen lights");
    await flush();
    await racing.clock.advance(longGapMs);
    expect(racing.log.sends.map((send) => send.text)).toEqual([
      "turn on the kitchen lights",
    ]);
  });

  it("records which path submitted each turn without transcript text", async () => {
    const complete = harness({
      endpoint: async (): Promise<EndpointResult> => ({
        decision: "finished",
        latencyMs: 41,
      }),
    });
    await complete.session.start();
    await complete.say("what is the weather in Lisbon");
    await complete.clock.advance(shortGapMs);
    expect(complete.log.endpoints).toEqual([
      { by: "semantic", semantic: "complete", latencyMs: 41 },
    ]);
    expect(JSON.stringify(complete.log.endpoints)).not.toContain("Lisbon");

    const incomplete = harness({
      endpoint: async () => ({ decision: "continue", latencyMs: 12 }),
    });
    await incomplete.session.start();
    await incomplete.say("remind me to");
    await incomplete.clock.advance(longGapMs - 1);
    expect(incomplete.log.sends).toHaveLength(0);
    await incomplete.clock.advance(1);
    expect(incomplete.log.endpoints).toEqual([
      { by: "gap", semantic: "incomplete", latencyMs: 12 },
    ]);

    const unavailable = harness({
      endpoint: async () => ({ decision: "unavailable", reason: "unscored" }),
    });
    await unavailable.session.start();
    await unavailable.say("turn off the lights");
    await unavailable.clock.advance(longGapMs - 1);
    expect(unavailable.log.sends).toHaveLength(0);
    await unavailable.clock.advance(1);
    expect(unavailable.log.endpoints).toEqual([
      { by: "gap", semantic: "unavailable", reason: "unscored" },
    ]);

    const error = harness({
      endpoint: () =>
        Promise.reject(Object.assign(Error("502"), { status: 502 })),
    });
    await error.session.start();
    await error.say("call mom");
    await error.clock.advance(longGapMs);
    expect(error.log.endpoints).toEqual([{ by: "gap", semantic: "error" }]);

    const signals: AbortSignal[] = [];
    const slow = harness({
      endpoint: (_text, signal) => {
        signals.push(signal);
        return new Promise(() => {});
      },
    });
    await slow.session.start();
    await slow.say("play some music");
    await slow.clock.advance(shortGapMs + endpointDeadlineMs);
    expect(signals[0]?.aborted).toBe(true);
    await slow.clock.advance(longGapMs);
    expect(slow.log.endpoints).toEqual([{ by: "gap", semantic: "timeout" }]);

    const absent = harness();
    await absent.session.start();
    await absent.say("hello");
    await absent.clock.advance(longGapMs);
    expect(absent.log.endpoints).toEqual([
      { by: "gap", semantic: "not-asked" },
    ]);
  });

  it("aborts a call on resumed speech, keeps one call in flight and asks the next utterance afresh", async () => {
    const calls: {
      text: string;
      signal: AbortSignal;
      d: Deferred<EndpointResult>;
    }[] = [];
    const h = harness({
      endpoint: (text, signal) => {
        const d = deferred<EndpointResult>();
        calls.push({ text, signal, d });
        return d.promise;
      },
    });
    await h.session.start();
    await h.say("set a timer for");
    await h.clock.advance(shortGapMs);
    expect(calls).toHaveLength(1);
    h.mic().onSpeechStart(h.clock.now());
    await flush();
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.d.resolve({ decision: "finished", latencyMs: 5 });
    await flush();
    expect(h.log.sends).toHaveLength(0);
    await h.clock.advance(400);
    h.mic().onSpeechEnd(h.clock.now());
    h.mic().onSegment("ten minutes");
    await flush();
    await h.clock.advance(shortGapMs);
    expect(calls.map((call) => call.text)).toEqual([
      "set a timer for",
      "set a timer for ten minutes",
    ]);
    await h.session.setMuted(true);
    await flush();
    await h.clock.advance(shortGapMs);
    expect(calls.filter((call) => !call.signal.aborted)).toHaveLength(1);
    calls.at(-1)?.d.resolve({ decision: "continue" });
    await flush();
    calls[1]?.d.resolve({ decision: "finished" });
    await flush();
    expect(h.log.sends).toHaveLength(0);
    await h.clock.advance(longGapMs);
    expect(h.log.sends.map((send) => send.text)).toEqual([
      "set a timer for ten minutes",
    ]);
    expect(h.log.endpoints).toEqual([
      { by: "gap", semantic: "incomplete", latencyMs: 300 },
    ]);
  });
});

describe("VoiceAssistantSession barge-in and heard content", () => {
  it("cancels an in-flight request on held speech, drops its late reply and sends the new speech next", async () => {
    const h = harness();
    await h.session.start();
    await h.say("book a table");
    await h.clock.advance(longGapMs);
    expect(h.log.sends).toHaveLength(1);
    const first = at(h.replies, 0);
    h.mic().onSpeechStart(h.clock.now());
    await flush();
    await h.clock.advance(560);
    h.mic().onSpeechEnd(h.clock.now());
    h.mic().onSegment("");
    await flush();
    expect(first.input.signal.aborted).toBe(false);
    expect(h.phase()).toBe("thinking");
    h.mic().onSpeechStart(h.clock.now());
    await flush();
    expect(first.input.signal.aborted).toBe(false);
    await h.clock.advance(bargeInConfirmMs);
    expect(first.input.signal.aborted).toBe(true);
    expect(h.log.turns.map(([event]) => event)).toEqual([
      "submitted",
      "interrupted",
    ]);
    await h.clock.advance(300);
    h.mic().onSpeechEnd(h.clock.now());
    h.mic().onSegment("for four people");
    await flush();
    await h.clock.advance(longGapMs);
    expect(h.log.sends.map((send) => send.text)).toEqual([
      "book a table",
      "for four people",
    ]);
    expect(h.log.sends[1]?.turnId).not.toBe(h.log.sends[0]?.turnId);
    h.answer(0, "Which restaurant?");
    await flush();
    expect(h.speeches).toHaveLength(0);
    h.answer(1, "Booked for four.");
    await flush();
    expect(h.speeches.map((speech) => speech.input.text)).toEqual([
      "Booked for four.",
    ]);
  });

  it("stops playback on accepted speech and keeps only the sentences that finished", async () => {
    const h = harness();
    await h.session.start();
    await h.say("tell me about my day");
    await h.clock.advance(longGapMs);
    h.answer(
      0,
      "You have three meetings today. The first starts at nine with Priya. Then lunch with Sam at noon.",
    );
    await flush();
    h.speeches[0]?.input.onStarted();
    await flush();
    expect(h.phase()).toBe("speaking");
    h.speeches[0]?.done.resolve();
    await flush();
    h.speeches[1]?.input.onStarted();
    await flush();
    h.mic().onSpeechStart(h.clock.now());
    await flush();
    await h.clock.advance(bargeInConfirmMs * 2);
    h.mic().onSpeechEnd(h.clock.now());
    await flush();
    expect(h.speeches[1]?.input.signal.aborted).toBe(false);
    h.mic().onSegment("wait");
    await flush();
    expect(h.speeches[1]?.input.signal.aborted).toBe(true);
    expect(h.speeches).toHaveLength(2);
    expect(h.log.heard).toEqual([
      {
        turnId: h.log.sends[0]?.turnId,
        replyId: "a-0",
        heard: "You have three meetings today.",
        unheard:
          "The first starts at nine with Priya. Then lunch with Sam at noon.",
        interrupted: true,
      },
    ]);
    expect(h.phase()).toBe("listening");
    h.speeches[1]?.input.onStarted();
    await flush();
    expect(h.phase()).toBe("listening");
  });

  it("Stop speaking interrupts like barge-in; a reply played to the end is heard in full", async () => {
    const h = harness();
    await h.session.start();
    await h.say("what time is it");
    await h.clock.advance(longGapMs);
    h.answer(0, "It is nine thirty in the morning.");
    await flush();
    expect(h.session.interruptSpeech()).toBe(false);
    h.speeches[0]?.input.onStarted();
    await flush();
    expect(h.session.interruptSpeech()).toBe(true);
    expect(h.log.heard.at(-1)).toMatchObject({ heard: "", interrupted: true });
    await h.say("and tomorrow");
    await h.clock.advance(longGapMs);
    h.answer(1, "Tomorrow is Thursday.");
    await flush();
    h.speeches[1]?.input.onStarted();
    h.speeches[1]?.done.resolve();
    await flush();
    expect(h.log.heard.at(-1)).toEqual({
      turnId: h.log.sends[1]?.turnId,
      replyId: "a-1",
      heard: "Tomorrow is Thursday.",
      unheard: "",
      interrupted: false,
    });
    expect(h.log.turns.map(([event]) => event)).toEqual([
      "submitted",
      "first-audio",
      "interrupted",
      "submitted",
      "first-audio",
      "finished",
    ]);
  });

  it("never sends the reply's own echo as a turn", async () => {
    const echo: AssistantPorts["shouldRespond"] = (text, context) =>
      !(context.agentSpeaking || context.replyAgeMs < 9000) ||
      !context.recentAgentReply.toLowerCase().includes(text.toLowerCase());
    const h = harness({ shouldRespond: echo });
    await h.session.start();
    await h.say("read my reminder");
    await h.clock.advance(longGapMs);
    h.answer(0, "Your reminder says to water the plants before you leave.");
    await flush();
    h.speeches[0]?.input.onStarted();
    await flush();
    await h.say("water the plants");
    expect(h.speeches[0]?.input.signal.aborted).toBe(false);
    expect(h.phase()).toBe("speaking");
    h.speeches[0]?.done.resolve();
    await flush();
    await h.clock.advance(longGapMs * 2);
    expect(h.log.sends).toHaveLength(1);
    expect(h.log.heard.at(-1)?.interrupted).toBe(false);
  });

  it("ignores speech during playback without an echo canceller; Stop speaking still interrupts", async () => {
    const h = harness({ fullDuplex: false });
    await h.session.start();
    await h.say("what is the forecast");
    await h.clock.advance(longGapMs);
    h.answer(0, "Sunny with a light breeze all afternoon.");
    await flush();
    h.speeches[0]?.input.onStarted();
    await flush();
    h.mic().onSpeechStart(h.clock.now());
    await flush();
    await h.clock.advance(bargeInConfirmMs * 2);
    h.mic().onSpeechEnd(h.clock.now());
    h.mic().onSegment("sunny with a light breeze");
    await flush();
    expect(h.speeches[0]?.input.signal.aborted).toBe(false);
    expect(h.session.interruptSpeech()).toBe(true);
    await h.clock.advance(longGapMs * 2);
    expect(h.log.sends).toHaveLength(1);
  });
});

describe("VoiceAssistantSession lifecycle and authority", () => {
  it("closes a microphone that finishes opening after Mute", async () => {
    const holdOpen = deferred();
    const h = harness({ holdOpen });
    const starting = h.session.start();
    await flush();
    const muting = h.session.setMuted(true);
    holdOpen.resolve();
    await starting;
    await muting;
    expect(h.log.closed).toBe(1);
    expect(h.session.muted).toBe(true);
    await h.session.setMuted(false);
    expect(h.log.captures).toBe(2);
  });

  it("stops on a binding change: capture discarded, nothing sent, late callbacks ignored", async () => {
    const h = harness();
    await h.session.start();
    await h.say("send a message to");
    h.setCurrent(false);
    h.session.recheck();
    await flush();
    expect(h.phase()).toBe("idle");
    expect(h.log.cancelled).toBe(1);
    h.mic().onSegment("Alex");
    h.mic().onSpeechStart(h.clock.now());
    await h.clock.advance(longGapMs * 3);
    expect(h.log.sends).toHaveLength(0);

    const g = harness();
    await g.session.start();
    await g.say("what is on my calendar");
    await g.clock.advance(longGapMs);
    g.setCurrent(false);
    g.session.recheck();
    await flush();
    expect(g.replies[0]?.input.signal.aborted).toBe(true);
    g.answer(0, "You are free all day.");
    await flush();
    expect(g.speeches).toHaveLength(0);
  });

  it("Stop discards an unsent utterance; Mute finalizes speech up to the mute", async () => {
    const h = harness();
    await h.session.start();
    await h.say("cancel my");
    await h.session.stop();
    await h.clock.advance(longGapMs * 2);
    expect(h.log.sends).toHaveLength(0);

    const m = harness();
    await m.session.start();
    m.mic().onSpeechStart(m.clock.now());
    await flush();
    const muting = m.session.setMuted(true);
    m.mic().onSpeechEnd(m.clock.now());
    m.mic().onSegment("turn off the alarm");
    await muting;
    expect(m.log.closed).toBe(1);
    await m.clock.advance(longGapMs);
    expect(m.log.sends.map((send) => send.text)).toEqual([
      "turn off the alarm",
    ]);
    m.mic().onSpeechStart(m.clock.now());
    await flush();
    expect(m.replies[0]?.input.signal.aborted).toBe(false);
    await m.session.setMuted(false);
    expect(m.log.captures).toBe(2);
  });

  it("Stop cancels a muted capture that is still finalizing", async () => {
    const h = harness();
    await h.session.start();
    let cancels = 0;
    const closing = deferred();
    const capture: AssistantCapture = {
      fullDuplex: true,
      close: () => closing.promise,
      cancel: () => {
        cancels++;
        closing.resolve();
      },
    };
    (h.session as unknown as { capture: AssistantCapture }).capture = capture;
    void h.session.setMuted(true);
    await flush();
    await h.session.stop();
    expect(cancels).toBe(1);
  });

  it("never approves: a reply with proposals ends voice without speaking it", async () => {
    const h = harness();
    await h.session.start();
    await h.say("delete my dentist appointment");
    await h.clock.advance(longGapMs);
    h.answer(0, "Review the deletion below.", { complete: false });
    await flush();
    expect(h.speeches).toHaveLength(0);
    expect(h.phase()).toBe("error");
    expect(h.log.cancelled).toBe(1);
  });

  it("keeps the microphone off during an owner-input pause until the exact approved result resumes", async () => {
    const h = harness();
    await h.session.start();
    await h.say("summarize my packing note");
    await h.clock.advance(longGapMs);
    h.answer(0, "Share the note?", {
      complete: false,
      awaitingUserInput: { proposalId: "p-1", digest: "d-1" },
    });
    await flush();
    const state = h.session.getSnapshot();
    expect(state.phase).toBe("awaiting-user-input");
    expect(h.log.cancelled).toBe(1);
    const pause = state.awaitingUserInput;
    if (!pause) throw new Error("expected a pause");
    const reply = {
      requestId: pause.requestId,
      conversationId: "room-1",
      userMessageId: pause.userMessageId,
      assistantMessageId: "a-2",
      complete: true,
    };
    expect(
      h.session.resume({
        pause: { ...pause, digest: "other" },
        reply: { ...reply, text: "x" },
      }),
    ).toBe(false);
    expect(
      h.session.resume({
        pause,
        reply: { ...reply, text: "Passport, charger and boots." },
      }),
    ).toBe(true);
    await flush();
    expect(h.log.captures).toBe(2);
    expect(h.speeches[0]?.input.text).toBe("Passport, charger and boots.");
  });
});

describe("splitSpokenSentences and timing", () => {
  it("keeps the reply text and avoids tiny fragments", () => {
    expect(
      splitSpokenSentences(
        "  Dr. Smith is in. The visit is at 9:30 on Tuesday. Bring your card!  ",
      ),
    ).toEqual([
      "Dr. Smith is in. The visit is at 9:30 on Tuesday.",
      "Bring your card!",
    ]);
    expect(splitSpokenSentences("")).toEqual([]);
    const text =
      "One sentence that is long enough. Another one that is long enough? Last.";
    expect(splitSpokenSentences(text).join(" ")).toBe(text);
  });

  it("refuses a long gap shorter than the short gap", () => {
    expect(
      () =>
        new VoiceAssistantSession(
          {
            conversationId: "r",
            assertCurrent() {},
            listen: async () => ({ close: async () => {}, cancel() {} }),
            send: async () => ({}) as AssistantReply,
            speak: async () => {},
          },
          { timing: { shortGapMs: 900, longGapMs: 300 } },
        ),
    ).toThrow(RangeError);
  });
});
